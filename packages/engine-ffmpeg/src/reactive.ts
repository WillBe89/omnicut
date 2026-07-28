/**
 * Audio-reactive music video: drives the whole frame from the song's energy.
 *
 * Pipeline:
 *  1. Decode the song to mono PCM once (ffmpeg -f f32le).
 *  2. Derive a bass-band envelope (JS one-pole low-pass) and a fast-attack /
 *     decay "shake" trigger from bass onsets.
 *  3. Compute a real 32-band log-spaced spectrum per video frame (our own FFT),
 *     normalized against THIS TRACK's own dynamic range per band — so the
 *     loudest hit in any song reaches full bar height, and the visual pattern
 *     is genuinely unique per song.
 *  4. Simulate deterministic ambient dust motes that drift in during the
 *     track's latter half.
 *  5. Render the EQ bars + dust into RGBA frames in JS and stream them into
 *     ffmpeg as a raw-video input; ffmpeg composites it over a shaking,
 *     zoom-pulsing cover (via `sendcmd`-driven crop) and encodes the result.
 *
 * Entirely deterministic — same song + cover always produce the same video.
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { probeMedia } from "./probe.js";
import { runFfmpeg, type FfmpegProgress } from "./run.js";
import { analyzeSpectrum } from "./spectrum.js";
import { simulateDust } from "./particles.js";
import {
  makeFrameBuffer, clearBuffer, drawBar, drawFlash, drawGlowDot, gradientColorAt, type Gradient4, type RGB,
} from "./eqcanvas.js";
import { spawn } from "node:child_process";
import { ffmpegPath } from "./ffmpeg-paths.js";
import { ffColor, filterPath } from "./escape.js";
import { chooseFontFile } from "./fonts.js";

const AR = 22050; // analysis sample rate (covers spectrum up to ~11kHz)

function decodePcm(songPath: string): Promise<Float32Array> {
  const args = ["-hide_banner", "-loglevel", "error", "-i", songPath,
    "-ac", "1", "-ar", String(AR), "-f", "f32le", "pipe:1"];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`PCM decode failed: ${err.slice(-400)}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

function lowpass(sig: Float32Array, sr: number, cutoffHz: number): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sr;
  const alpha = dt / (rc + dt);
  const out = new Float32Array(sig.length);
  let y = 0;
  for (let i = 0; i < sig.length; i++) {
    y += alpha * (sig[i]! - y);
    out[i] = y;
  }
  return out;
}

function frameRms(sig: Float32Array, nf: number, hop: number): Float64Array {
  const out = new Float64Array(nf);
  for (let f = 0; f < nf; f++) {
    const start = Math.floor(f * hop);
    const end = Math.min(sig.length, start + Math.floor(hop));
    let sum = 0;
    for (let i = start; i < end; i++) sum += sig[i]! * sig[i]!;
    out[f] = Math.sqrt(sum / Math.max(1, end - start) + 1e-9);
  }
  return out;
}

function percentile(arr: Float64Array, p: number): number {
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 1;
}

function normalize(arr: Float64Array, p = 97): Float64Array {
  const m = percentile(arr, p) + 1e-9;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.max(0, Math.min(1, arr[i]! / m));
  return out;
}

/** Deterministic pseudo-random in [-1,1] from an integer seed (shake direction). */
function jitter(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export interface ReactiveGeometry {
  W: number; H: number; fps: number;
  ow: number; oh: number; // overscan base size for crop-shake
  cover: number;          // sharp cover square size on the base
  maxShake: number; zoom: number;
}

function defaultGeometry(W = 1920, H = 1080, fps = 30): ReactiveGeometry {
  return { W, H, fps, ow: 2112, oh: 1188, cover: 968, maxShake: 62, zoom: 0.1 };
}

interface Envelopes {
  energyN: Float64Array;
  bassN: Float64Array;
  shake: Float64Array;
  pcm: Float32Array;
}

async function analyzeEnvelopes(songPath: string, fps: number, durationSec: number): Promise<Envelopes> {
  const full = await decodePcm(songPath);
  const bass = lowpass(full, AR, 160);
  const nf = Math.floor(durationSec * fps);
  const hop = AR / fps;
  const energyN = normalize(frameRms(full, nf, hop));
  const bassN = normalize(frameRms(bass, nf, hop));

  const onsetRaw = new Float64Array(nf);
  for (let f = 1; f < nf; f++) onsetRaw[f] = Math.max(0, bassN[f]! - bassN[f - 1]!);
  const onset = normalize(onsetRaw, 96);
  const shake = new Float64Array(nf);
  let s = 0;
  for (let f = 0; f < nf; f++) {
    s = Math.max(s * 0.8, onset[f]!);
    shake[f] = Math.pow(Math.max(0, Math.min(1, (s - 0.25) / 0.75)), 1.3);
  }
  return { energyN, bassN, shake, pcm: full };
}

/** Slow exponential smoothing of `shake` = "how heavy is this section right
 *  now" (as opposed to `shake`'s own frame-to-frame spikes). Driving dust
 *  density off this — rather than a separate energy cue — is what makes the
 *  dust visibly thicken in the same heavy sections that trigger the EQ/shake. */
function sectionIntensity(shake: Float64Array, fps: number, tauSec = 1.5): Float64Array {
  const alpha = 1 - Math.exp(-1 / (fps * tauSec));
  const out = new Float64Array(shake.length);
  let acc = 0;
  for (let f = 0; f < shake.length; f++) {
    acc += alpha * (shake[f]! - acc);
    out[f] = acc;
  }
  return out;
}

function buildCommands(env: Envelopes, g: ReactiveGeometry): string {
  const lines: string[] = [];
  const nf = env.shake.length;
  for (let f = 0; f < nf; f++) {
    const t = f / g.fps;
    // Frame 0 stays perfectly neutral — a clean, well-framed cover shot with
    // no shake/zoom offset, usable as a YouTube thumbnail.
    if (f === 0) {
      const cx0 = (g.ow - g.W) / 2, cy0 = (g.oh - g.H) / 2;
      lines.push(`0.0000 crop w ${g.W}, crop h ${g.H}, crop x ${cx0}, crop y ${cy0}, eq saturation 1.0, eq brightness 0.0;`);
      continue;
    }
    const z = 1 + g.zoom * env.bassN[f]!;
    const cw = Math.round(g.W / z / 2) * 2;
    const ch = Math.round(g.H / z / 2) * 2;
    const sx = env.shake[f]! * g.maxShake * jitter(f * 2 + 1);
    const sy = env.shake[f]! * g.maxShake * jitter(f * 2 + 7);
    const cx = (g.ow - cw) / 2 + sx;
    const cy = (g.oh - ch) / 2 + sy;
    const sat = 1.05 + 0.55 * env.energyN[f]!;
    const bri = 0.02 * env.energyN[f]!;
    lines.push(
      `${t.toFixed(4)} crop w ${cw}, crop h ${ch}, crop x ${cx.toFixed(1)}, crop y ${cy.toFixed(1)}, eq saturation ${sat.toFixed(3)}, eq brightness ${bri.toFixed(3)};`,
    );
  }
  return lines.join("\n");
}

const DEFAULT_EQ_GRADIENT: Gradient4 = { c0: [255, 42, 77], c1: [162, 75, 255], c2: [43, 107, 255], c3: [34, 224, 255] };

function hexToRgb(hex: string): RGB {
  const clean = hex.replace(/^#/, "");
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

/** Build a smooth 4-stop gradient from two anchor colors (start/end). */
function gradientFromPair(colors: [string, string]): Gradient4 {
  const a = hexToRgb(colors[0]);
  const b = hexToRgb(colors[1]);
  const lerp = (t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  return { c0: a, c1: lerp(1 / 3), c2: lerp(2 / 3), c3: b };
}

/** Stream EQ-bars + dust frames into ffmpeg's stdin as raw RGBA video. */
async function feedEqDustFrames(
  stdin: Writable,
  nf: number,
  fps: number,
  W: number,
  H: number,
  spectrum: { bands: number; data: Float32Array },
  dust: ReturnType<typeof simulateDust>,
  shake: Float64Array,
  gradient: Gradient4,
): Promise<void> {
  const buf = makeFrameBuffer(W, H);
  const nBands = spectrum.bands;
  const gap = 2;
  const barW = Math.floor((W - gap * (nBands + 1)) / nBands);
  const eqHeightFrac = 0.55; // EQ occupies the bottom ~55% of this canvas — big and present
  const bassBands = Math.round(nBands * 0.28); // lowest ~28% of bars = bass region

  for (let f = 0; f < nf; f++) {
    clearBuffer(buf);
    // Frame 0 is left fully blank (transparent) so the composite shows just
    // the clean cover — a usable YouTube thumbnail frame.
    if (f === 0) {
      const ok0 = stdin.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
      if (!ok0) await once(stdin, "drain");
      continue;
    }
    // The kick detector (same signal that drives screen-shake) is the ground
    // truth for "a real hit is happening right now" — couple the EQ to it
    // directly so it spikes exactly when the shake does, not just whenever
    // the raw spectrum happens to be broadband-loud (risers/pads).
    const kick = shake[f]!;
    const punch = 0.6 + 0.65 * kick; // whole EQ swells together on every real hit

    if (kick > 0.35) drawFlash(buf, W, H, Math.round(H * (1 - eqHeightFrac)), H, (kick - 0.35) / 0.65);

    for (let b = 0; b < nBands; b++) {
      const u = nBands > 1 ? b / (nBands - 1) : 0;
      const color = gradientColorAt(u, gradient);
      const x = gap + b * (barW + gap);
      let v = spectrum.data[f * nBands + b]!;
      if (b < bassBands) v = Math.max(v, kick); // bass bars slam with every kick
      const h = Math.min(1, v * punch);
      drawBar(buf, W, H, x, barW, h * eqHeightFrac, color);
    }
    const t = f / fps;
    for (const p of dust[f]!) {
      const age = t - p.born;
      const lifeFrac = age / p.life;
      const alpha = lifeFrac < 0.15 ? lifeFrac / 0.15 : lifeFrac > 0.6 ? Math.max(0, 1 - (lifeFrac - 0.6) / 0.4) : 1;
      const x = p.x + p.vx * age;
      const y = p.y + p.vy * age + 0.5 * p.gravity * age * age;
      drawGlowDot(buf, W, H, x, y, p.size, p.color, 0.55 * alpha);
    }
    const ok = stdin.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
    if (!ok) await once(stdin, "drain");
  }
  stdin.end();
}

export interface WatermarkBox {
  /** Bounding box in the SOURCE's native resolution (not the output frame). */
  x: number; y: number; w: number; h: number;
}

export interface ReactiveOptions {
  coverPath: string;
  /** Set when coverPath points to a video (looped for the song's full length)
   *  rather than a still image. */
  coverIsVideo?: boolean;
  /** Blur out a logo/watermark baked into the source at this box (e.g. an
   *  AI-animator's watermark) — a targeted blur reads far more natural than
   *  delogo's inpainting when the area has busy detail nearby. */
  watermarkBox?: WatermarkBox;
  /** Song title burned in as a top title-bar overlay (shows on every frame,
   *  including the clean frame 0, so the thumbnail carries it too). */
  titleText?: string;
  /** Two hex colors forming the EQ's gradient (interpolated to 4 stops). */
  accentColors?: [string, string];
  songPath: string;
  outputPath: string;
  width?: number; height?: number; fps?: number;
  /** Fraction of the track (0..1) after which dust may start appearing (default 0.5). */
  dustStartFraction?: number;
  workDir: string;
  onProgress?: (p: FfmpegProgress) => void;
  onCommand?: (cmd: string) => void;
  signal?: AbortSignal;
}

export interface ReactiveResult {
  outputPath: string;
  duration: number;
}

export async function renderMusicVideoReactive(opts: ReactiveOptions): Promise<ReactiveResult> {
  const W = opts.width ?? 1920, H = opts.height ?? 1080, fps = opts.fps ?? 30;
  const song = await probeMedia(opts.songPath);
  const duration = song.duration;
  if (!duration || duration <= 0) throw new Error(`Could not read song duration: ${opts.songPath}`);

  const g = defaultGeometry(W, H, fps);
  const env = await analyzeEnvelopes(opts.songPath, fps, duration);
  const spectrum = analyzeSpectrum(env.pcm, AR, fps, duration, { bands: 32 });

  // Half-resolution eq/dust canvas (same aspect as the output) — 4x fewer
  // pixels to draw/stream; ffmpeg upscales it, which also softens it nicely.
  const EQW = Math.round(W / 2 / 2) * 2;
  const EQH = Math.round(H / 2 / 2) * 2;
  // Smoothed "how heavy is this section" — normalized against THIS song's own
  // busiest stretch (the raw signal rarely nears 1.0, so an absolute scale
  // would leave dust looking sparse even at the track's most intense parts).
  const intensity = normalize(sectionIntensity(env.shake, fps), 92);
  const dust = simulateDust(spectrum.nf, fps, EQW, EQH, intensity, {
    startFraction: opts.dustStartFraction ?? 0.5,
  });
  const gradient = opts.accentColors ? gradientFromPair(opts.accentColors) : DEFAULT_EQ_GRADIENT;

  await mkdir(opts.workDir, { recursive: true });
  const cmdsPath = join(opts.workDir, "reactive.cmds");
  await writeFile(cmdsPath, buildCommands(env, g), "utf8");
  const cmdsEsc = cmdsPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  // If the source has a baked-in watermark, blur-patch it out BEFORE the
  // bg/fg split (delogo's inpainting streaks badly against busy detail like
  // chain links; a targeted blur reads as a natural dark corner instead).
  const srcLabel = "srcfixed";
  const wmFilters: string[] = [];
  if (opts.watermarkBox) {
    const { x, y, w, h } = opts.watermarkBox;
    wmFilters.push(
      `[0:v]crop=${w}:${h}:${x}:${y},gblur=sigma=30,eq=brightness=-0.15[wmpatch]`,
      `[0:v][wmpatch]overlay=${x}:${y}[${srcLabel}]`,
    );
  }
  const baseSrc = opts.watermarkBox ? `[${srcLabel}]` : "[0:v]";

  const fc = [
    ...wmFilters,
    `${baseSrc}split=2[cb][cf]`,
    `[cb]scale=${g.ow}:${g.oh}:force_original_aspect_ratio=increase,crop=${g.ow}:${g.oh},gblur=sigma=45,eq=brightness=-0.18:saturation=1.25[bg]`,
    `[cf]scale=${g.cover}:${g.cover}:force_original_aspect_ratio=increase,crop=${g.cover}:${g.cover},setsar=1[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
    `[base]sendcmd=f='${cmdsEsc}',crop=${W}:${H}:${(g.ow - W) / 2}:${(g.oh - H) / 2},scale=${W}:${H},eq=saturation=1.05:brightness=0[styled]`,
    `[2:v]scale=${W}:${H}:flags=bicubic[eqdust]`,
    `[styled][eqdust]overlay=0:0:eof_action=repeat[witheq]`,
    `[witheq]noise=alls=4:allf=t,vignette=PI/4.5[vout]`,
    ...titleTextFilters(opts.titleText, W),
  ].join(";");

  const inputArgs = opts.coverIsVideo
    ? ["-stream_loop", "-1", "-i", opts.coverPath]
    : ["-loop", "1", "-framerate", String(fps), "-i", opts.coverPath];

  const finalLabel = opts.titleText ? "titled" : "vout";
  const args = [
    "-hide_banner",
    ...inputArgs,
    "-i", opts.songPath,
    "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${EQW}x${EQH}`, "-framerate", String(fps), "-i", "pipe:0",
    "-filter_complex", fc,
    "-map", `[${finalLabel}]`, "-map", "1:a",
    "-r", String(fps),
    "-c:v", "libx264", "-preset", "medium", "-crf", "22",
    "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-t", String(duration), "-movflags", "+faststart", "-y", opts.outputPath,
  ];

  try {
    await runFfmpeg(args, {
      duration,
      onProgress: opts.onProgress,
      onCommand: opts.onCommand,
      signal: opts.signal,
      feedStdin: (stdin) => feedEqDustFrames(stdin, spectrum.nf, fps, EQW, EQH, spectrum, dust, env.shake, gradient),
    });
  } finally {
    await rm(cmdsPath, { force: true }).catch(() => {});
  }
  return { outputPath: opts.outputPath, duration };
}

/** A full-width title bar burned across the top of every frame (thumbnail
 *  included), since these albums share one cover/background across tracks
 *  and have no other way to show which song is playing. */
function titleTextFilters(titleText: string | undefined, W: number): string[] {
  if (!titleText) return [];
  const fontFile = chooseFontFile({
    content: "", fontSize: 0, color: "#FFFFFF", align: "center",
    bold: true, italic: false, backgroundOpacity: 1, outlineWidth: 0,
  });
  const barHeight = 108;
  const escaped = titleText.replace(/'/g, "’").replace(/:/g, "：");
  return [
    `[vout]drawbox=x=0:y=0:w=${W}:h=${barHeight}:color=black@0.55:t=fill[barred]`,
    [
      `[barred]drawtext=fontfile='${filterPath(fontFile)}'`,
      `text='${escaped}'`,
      "fontsize=54",
      `fontcolor=${ffColor("#FFFFFF")}`,
      "x=(w-text_w)/2",
      `y=${(barHeight - 54) / 2 - 6}`,
      "borderw=2",
      `bordercolor=${ffColor("#000000")}`,
    ].join(":") + "[titled]",
  ];
}
