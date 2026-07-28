/**
 * "Living Cover" music-video renderer: turns a cover image + a song into a
 * 1080p video the length of the track, with deterministic motion and
 * music-synced energy — Ken Burns zoom, blurred background fill, an
 * audio-reactive visualizer, and film grain/vignette. All FFmpeg-native.
 */
import { probeMedia } from "./probe.js";
import { runFfmpeg } from "./run.js";
import type { FfmpegProgress } from "./run.js";

export type VisualizerStyle = "waveform" | "bars" | "spectrum" | "none";

export interface MusicVideoEffects {
  kenBurns: boolean;
  blurFill: boolean;
  filmGrain: boolean;
  visualizer: VisualizerStyle;
}

export interface MusicVideoOptions {
  coverPath: string;
  songPath: string;
  outputPath: string;
  width?: number;
  height?: number;
  fps?: number;
  effects?: Partial<MusicVideoEffects>;
  /** Two hex accent colors for the visualizer (default brandable red/purple). */
  accentColors?: [string, string];
  /** Sharp cover height as a fraction of the frame height (default 0.93). */
  coverHeightRatio?: number;
  /** Max Ken Burns zoom reached at the end of the song (default 1.12). */
  maxZoom?: number;
  workDir: string;
  onProgress?: (p: FfmpegProgress) => void;
  onCommand?: (cmd: string) => void;
  signal?: AbortSignal;
}

export interface MusicVideoResult {
  outputPath: string;
  duration: number;
}

const DEFAULT_EFFECTS: MusicVideoEffects = {
  kenBurns: true,
  blurFill: true,
  filmGrain: true,
  visualizer: "bars",
};

function ffColor(hex: string): string {
  return `0x${hex.replace(/^#/, "").replace(/^0x/i, "").toUpperCase()}`;
}
const n = (x: number) => (Math.round(x * 1e5) / 1e5).toString();
const even = (x: number) => Math.round(x / 2) * 2;

/** Build the visualizer sub-graph producing a transparent `[wave]` overlay. */
function buildVisualizer(
  style: VisualizerStyle,
  W: number,
  vizH: number,
  fps: number,
  c1: string,
  c2: string,
): string | null {
  switch (style) {
    case "waveform":
      return `[1:a]showwaves=s=${W}x${vizH}:mode=cline:rate=${fps}:colors=${c1}|${c2},format=rgba,colorkey=0x000000:0.14:0.06,gblur=sigma=2[wave]`;
    case "bars":
      // sqrt amplitude scale = punchy dynamics (drops tower, quiet stays calm);
      // averaging smooths frame-to-frame jitter; a slight pre-gain adds presence.
      return `[1:a]volume=1.6,showfreqs=s=${W}x${vizH}:mode=bar:ascale=sqrt:fscale=log:averaging=14:win_size=4096:win_func=hann:colors=${c1}|${c2},format=rgba,colorkey=0x000000:0.10:0.05,gblur=sigma=1.6[wave]`;
    case "spectrum":
      return `[1:a]showcqt=s=${W}x${vizH}:fps=${fps}:count=1:bar_g=2,format=rgba,colorkey=0x000000:0.10:0.04[wave]`;
    default:
      return null;
  }
}

/** Probe the song, assemble the filter graph, and render the music video. */
export async function renderMusicVideo(opts: MusicVideoOptions): Promise<MusicVideoResult> {
  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const fps = opts.fps ?? 30;
  const effectOverrides = Object.fromEntries(
    Object.entries(opts.effects ?? {}).filter(([, v]) => v !== undefined),
  );
  const fx: MusicVideoEffects = { ...DEFAULT_EFFECTS, ...effectOverrides };
  const [c1, c2] = opts.accentColors ?? ["#ff3b4e", "#9a6bff"];
  const ratio = opts.coverHeightRatio ?? 0.93;
  const maxZoom = opts.maxZoom ?? 1.12;

  const song = await probeMedia(opts.songPath);
  const duration = song.duration;
  if (!duration || duration <= 0) throw new Error(`Could not read song duration: ${opts.songPath}`);

  const fgSize = even(H * ratio);
  const parts: string[] = [];

  // 1. Background: blurred fill, or solid black.
  if (fx.blurFill) {
    parts.push("[0:v]split=2[cb][cf]");
    parts.push(
      `[cb]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=45,eq=brightness=-0.18:saturation=1.25,setsar=1[bg]`,
    );
  } else {
    parts.push(`color=c=black:s=${W}x${H}:r=${fps},setsar=1[bg]`);
    parts.push("[0:v]null[cf]");
  }

  // 2. Foreground: sharp cover, fit to a square box, optional Ken Burns zoom.
  const fgChain: string[] = [
    `scale=${fgSize}:${fgSize}:force_original_aspect_ratio=increase`,
    `crop=${fgSize}:${fgSize}`,
  ];
  if (fx.kenBurns) {
    const step = (maxZoom - 1) / (duration * fps);
    fgChain.push(
      `zoompan=z='min(1+${n(step)}*on,${n(maxZoom)})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${fgSize}x${fgSize}:fps=${fps}`,
    );
  } else {
    fgChain.push(`fps=${fps}`);
  }
  fgChain.push("setsar=1");
  parts.push(`[cf]${fgChain.join(",")}[fg]`);

  // 3. Composite sharp cover centered over the background.
  parts.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`);
  let vlabel = "base";

  // 4. Audio-reactive visualizer across the bottom.
  if (fx.visualizer !== "none") {
    const vizH = even(H * 0.24);
    const viz = buildVisualizer(fx.visualizer, W, vizH, fps, ffColor(c1), ffColor(c2));
    if (viz) {
      parts.push(viz);
      parts.push(`[${vlabel}][wave]overlay=0:${H - vizH - 20}[wv]`);
      vlabel = "wv";
    }
  }

  // 5. Film look: light animated grain + vignette + a touch of vibrance.
  //    Grain is kept subtle (alls=4) — heavy temporal noise is uncompressible
  //    and balloons file size; a capped bitrate below bounds it regardless.
  if (fx.filmGrain) {
    parts.push(`[${vlabel}]noise=alls=4:allf=t,vignette=PI/4.5,eq=saturation=1.06[vout]`);
    vlabel = "vout";
  } else {
    parts.push(`[${vlabel}]vignette=PI/5[vout]`);
    vlabel = "vout";
  }

  const args = [
    "-hide_banner",
    "-loop", "1", "-framerate", n(fps), "-i", opts.coverPath,
    "-i", opts.songPath,
    "-filter_complex", parts.join(";"),
    "-map", `[${vlabel}]`,
    "-map", "1:a",
    "-r", n(fps),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "22",
    // Cap the bitrate so grain/visualizer can't balloon the file (YouTube-friendly).
    "-maxrate", "8M",
    "-bufsize", "16M",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", n(duration),
    "-movflags", "+faststart",
    "-y",
    opts.outputPath,
  ];

  await runFfmpeg(args, {
    duration,
    onProgress: opts.onProgress,
    onCommand: opts.onCommand,
    signal: opts.signal,
  });
  return { outputPath: opts.outputPath, duration };
}
