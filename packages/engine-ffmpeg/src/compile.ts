/**
 * Compiles a Project timeline into a single deterministic FFmpeg invocation.
 *
 * Model (CapCut-tier, robust for a handful of clips):
 *  - The FIRST video track is the "main sequence": its clips are laid end-to-end
 *    (gaps filled with background) and joined with hard cuts or xfade transitions.
 *  - Every other video/overlay track is composited on top as a positioned overlay,
 *    timed to its absolute timeline position (supports PiP, images, text).
 *  - Audio from every non-muted clip (main audio, PiP audio, music) is trimmed,
 *    speed-matched, faded, positioned (adelay) and mixed (amix) over a silent bed
 *    that guarantees a full-length audio track.
 *
 * Each clip that references a media asset becomes exactly one `-i` input (trimmed
 * at the input level with -ss/-t), which keeps the filtergraph simple and lets the
 * same asset be reused by multiple clips without split plumbing.
 */
import type { Clip, MediaAsset, Project, Track } from "@video-editor/core";
import { getAsset, projectDuration } from "@video-editor/core";
import { join } from "node:path";
import { ffColor, filterPath, num } from "./escape.js";
import { chooseFontFile } from "./fonts.js";

export interface CompiledRender {
  /** FFmpeg arguments (excluding the ffmpeg binary itself). */
  args: string[];
  /** Temp files (drawtext text) that must be written before invoking ffmpeg. */
  tempFiles: { path: string; content: string }[];
  /** Total output duration in seconds. */
  duration: number;
}

interface ClipInput {
  clip: Clip;
  asset: MediaAsset;
  index: number; // ffmpeg input index
}

/** Decompose an arbitrary speed factor into a chain of atempo filters (0.5–2.0 each). */
function atempoChain(speed: number): string[] {
  const parts: string[] = [];
  let s = speed;
  while (s > 2.0) {
    parts.push("atempo=2.0");
    s /= 2.0;
  }
  while (s < 0.5) {
    parts.push("atempo=0.5");
    s *= 2.0;
  }
  parts.push(`atempo=${num(s)}`);
  return parts;
}

export function compileTimeline(
  project: Project,
  outputPath: string,
  workDir: string,
): CompiledRender {
  const { width: W, height: H, fps, sampleRate: SR, background } = project.settings;
  const total = projectDuration(project);
  if (total <= 0) throw new Error("Nothing to render: the timeline is empty.");

  const inputArgs: string[] = [];
  const filters: string[] = [];
  const tempFiles: { path: string; content: string }[] = [];
  const clipInputs = new Map<string, ClipInput>();
  let inputIndex = 0;

  // 1. One -i per media-backed clip (trimmed at the input level).
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.assetId) continue; // text clip: no input
      const asset = getAsset(project, clip.assetId);
      if (asset.type === "image") {
        inputArgs.push(
          "-loop", "1",
          "-framerate", num(fps),
          "-t", num(clip.duration),
          "-i", asset.path,
        );
      } else {
        const span = Math.max(0.001, clip.sourceOut - clip.sourceIn);
        inputArgs.push("-ss", num(clip.sourceIn), "-t", num(span), "-i", asset.path);
      }
      clipInputs.set(clip.id, { clip, asset, index: inputIndex });
      inputIndex++;
    }
  }

  const videoTracks = project.tracks.filter((t) => t.type === "video");
  const mainTrack = videoTracks[0];
  const overlayTracks = project.tracks.filter(
    (t) => (t.type === "video" && t !== mainTrack) || t.type === "overlay",
  );

  // 2. Build the main sequence (or a bare canvas if there's no main track).
  let baseLabel: string;
  const seq = mainTrack ? buildMainSequence(mainTrack, clipInputs, W, H, fps, background, filters) : null;

  const bgLabel = "bg";
  filters.push(
    `color=c=${ffColor(background)}:s=${W}x${H}:r=${num(fps)}:d=${num(total)},setsar=1,format=yuv420p[${bgLabel}]`,
  );
  if (seq) {
    filters.push(`[${bgLabel}][${seq.label}]overlay=eof_action=pass:x=0:y=0[base0]`);
    baseLabel = "base0";
  } else {
    baseLabel = bgLabel;
  }

  // 3. Composite overlay tracks (PiP video/image + text) in track order.
  let overlayCounter = 0;
  for (const track of overlayTracks) {
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      const nextLabel = `ov${overlayCounter++}`;
      if (clip.text) {
        filters.push(buildTextOverlay(clip, baseLabel, nextLabel, W, H, workDir, tempFiles));
      } else {
        const ci = clipInputs.get(clip.id);
        if (!ci) continue;
        buildVisualOverlay(ci, baseLabel, nextLabel, W, H, fps, filters);
      }
      baseLabel = nextLabel;
    }
  }

  const voutLabel = baseLabel;

  // 4. Audio: silent bed + every audible clip, mixed.
  const audioLabels: string[] = [];
  filters.push(`anullsrc=r=${SR}:cl=stereo,atrim=0:${num(total)}[abed]`);
  audioLabels.push("abed");

  let aCounter = 0;
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      const ci = clipInputs.get(clip.id);
      if (!ci || !ci.asset.hasAudio) continue;
      const label = `a${aCounter++}`;
      filters.push(buildClipAudio(ci, label, SR));
      audioLabels.push(label);
    }
  }

  const aoutLabel = "aout";
  filters.push(
    `${audioLabels.map((l) => `[${l}]`).join("")}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,atrim=0:${num(total)}[${aoutLabel}]`,
  );

  const args: string[] = [
    "-hide_banner",
    ...inputArgs,
    "-filter_complex",
    filters.join(";"),
    "-map", `[${voutLabel}]`,
    "-map", `[${aoutLabel}]`,
    "-r", num(fps),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", num(SR),
    "-t", num(total),
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ];

  return { args, tempFiles, duration: total };
}

// ─────────────────────────────────────────────────────────── main sequence

function normalizeFullFrame(
  ci: ClipInput,
  label: string,
  W: number,
  H: number,
  fps: number,
  bg: string,
  filters: string[],
): void {
  const { clip, index } = ci;
  const chain: string[] = [
    `setpts=(PTS-STARTPTS)/${num(clip.speed)}`,
    `fps=${num(fps)}`,
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:${ffColor(bg)}`,
    "setsar=1",
    "format=yuv420p",
  ];
  if (clip.fadeIn > 0) chain.push(`fade=t=in:st=0:d=${num(clip.fadeIn)}`);
  if (clip.fadeOut > 0) {
    chain.push(`fade=t=out:st=${num(Math.max(0, clip.duration - clip.fadeOut))}:d=${num(clip.fadeOut)}`);
  }
  filters.push(`[${index}:v]${chain.join(",")}[${label}]`);
}

interface Segment {
  label: string;
  duration: number;
  transitionAfter?: Clip["transitionOut"];
}

function buildMainSequence(
  track: Track,
  clipInputs: Map<string, ClipInput>,
  W: number,
  H: number,
  fps: number,
  bg: string,
  filters: string[],
): { label: string; duration: number } | null {
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  if (clips.length === 0) return null;

  const segments: Segment[] = [];
  let cursor = 0;
  let fillerCount = 0;
  let segCount = 0;

  for (const clip of clips) {
    // Fill any gap before this clip with background so overlay timing stays absolute.
    if (clip.start - cursor > 0.001) {
      const gap = clip.start - cursor;
      const label = `fill${fillerCount++}`;
      filters.push(
        `color=c=${ffColor(bg)}:s=${W}x${H}:r=${num(fps)}:d=${num(gap)},setsar=1,format=yuv420p[${label}]`,
      );
      segments.push({ label, duration: gap });
    }
    const ci = clipInputs.get(clip.id);
    if (!ci) continue;
    const label = `mv${segCount++}`;
    normalizeFullFrame(ci, label, W, H, fps, bg, filters);
    segments.push({ label, duration: clip.duration, transitionAfter: clip.transitionOut });
    cursor = clip.start + clip.duration;
  }

  // Fold segments together with xfade (transitions) or concat (hard cuts).
  let accLabel = segments[0]!.label;
  let accDur = segments[0]!.duration;
  let foldCount = 0;

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!;
    const seg = segments[i]!;
    const out = `seq${foldCount++}`;
    const trans = prev.transitionAfter;
    const d = trans ? Math.min(trans.duration, accDur * 0.99, seg.duration * 0.99) : 0;

    if (trans && d > 0.01) {
      const offset = accDur - d;
      filters.push(
        `[${accLabel}][${seg.label}]xfade=transition=${trans.type}:duration=${num(d)}:offset=${num(offset)}[${out}]`,
      );
      accDur = accDur + seg.duration - d;
    } else {
      filters.push(`[${accLabel}][${seg.label}]concat=n=2:v=1:a=0[${out}]`);
      accDur = accDur + seg.duration;
    }
    accLabel = out;
  }

  return { label: accLabel, duration: accDur };
}

// ──────────────────────────────────────────────────────────────── overlays

function buildVisualOverlay(
  ci: ClipInput,
  baseLabel: string,
  outLabel: string,
  W: number,
  H: number,
  fps: number,
  filters: string[],
): void {
  const { clip, index } = ci;
  const targetW = Math.max(2, Math.round(W * clip.transform.scale));
  const pre = `pre_${outLabel}`;

  const chain: string[] = [
    `setpts=(PTS-STARTPTS)/${num(clip.speed)}`,
    `fps=${num(fps)}`,
    `scale=${targetW}:-2`,
    "format=rgba",
    `colorchannelmixer=aa=${num(clip.opacity)}`,
  ];
  if (clip.fadeIn > 0) chain.push(`fade=t=in:st=0:d=${num(clip.fadeIn)}:alpha=1`);
  if (clip.fadeOut > 0) {
    chain.push(`fade=t=out:st=${num(Math.max(0, clip.duration - clip.fadeOut))}:d=${num(clip.fadeOut)}:alpha=1`);
  }
  // Shift PTS so the clip appears at its absolute timeline start.
  chain.push(`setpts=PTS+${num(clip.start)}/TB`);
  filters.push(`[${index}:v]${chain.join(",")}[${pre}]`);

  const end = clip.start + clip.duration;
  const x = `(W*${num(clip.transform.x)}-w/2)`;
  const y = `(H*${num(clip.transform.y)}-h/2)`;
  filters.push(
    `[${baseLabel}][${pre}]overlay=x='${x}':y='${y}':eof_action=pass:enable='between(t,${num(clip.start)},${num(end)})'[${outLabel}]`,
  );
}

function buildTextOverlay(
  clip: Clip,
  baseLabel: string,
  outLabel: string,
  W: number,
  H: number,
  workDir: string,
  tempFiles: { path: string; content: string }[],
): string {
  const text = clip.text!;
  const fontFile = chooseFontFile(text);
  const textPath = join(workDir, `text_${clip.id}.txt`);
  tempFiles.push({ path: textPath, content: text.content });

  const fontSizePx = Math.max(8, Math.round(H * text.fontSize));
  const end = clip.start + clip.duration;

  const opts: string[] = [
    `fontfile='${filterPath(fontFile)}'`,
    `textfile='${filterPath(textPath)}'`,
    "expansion=none",
    `fontsize=${fontSizePx}`,
    `fontcolor=${ffColor(text.color)}`,
    `x=(w*${num(clip.transform.x)}-text_w/2)`,
    `y=(h*${num(clip.transform.y)}-text_h/2)`,
    `enable='between(t,${num(clip.start)},${num(end)})'`,
  ];
  if (text.outlineColor && text.outlineWidth > 0) {
    const scaledBorder = Math.max(1, Math.round((text.outlineWidth * H) / 1080));
    opts.push(`borderw=${scaledBorder}`, `bordercolor=${ffColor(text.outlineColor)}`);
  }
  if (text.background) {
    opts.push("box=1", `boxcolor=${ffColor(text.background, text.backgroundOpacity)}`, "boxborderw=12");
  }
  return `[${baseLabel}]drawtext=${opts.join(":")}[${outLabel}]`;
}

// ─────────────────────────────────────────────────────────────────── audio

function buildClipAudio(ci: ClipInput, label: string, SR: number): string {
  const { clip, index } = ci;
  const chain: string[] = ["asetpts=PTS-STARTPTS"];
  if (clip.speed !== 1) chain.push(...atempoChain(clip.speed));
  if (clip.volume !== 1) chain.push(`volume=${num(clip.volume)}`);
  if (clip.audioFadeIn > 0) chain.push(`afade=t=in:st=0:d=${num(clip.audioFadeIn)}`);
  if (clip.audioFadeOut > 0) {
    chain.push(`afade=t=out:st=${num(Math.max(0, clip.duration - clip.audioFadeOut))}:d=${num(clip.audioFadeOut)}`);
  }
  chain.push(`aresample=${SR}`);
  const delayMs = Math.round(clip.start * 1000);
  if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`);
  return `[${index}:a]${chain.join(",")}[${label}]`;
}
