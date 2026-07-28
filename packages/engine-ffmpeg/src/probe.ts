import { execFile } from "node:child_process";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import type { MediaAsset, MediaType } from "@video-editor/core";
import { ffprobePath } from "./ffmpeg-paths.js";

const execFileAsync = promisify(execFile);

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff"]);

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  duration?: string;
}
interface FfprobeFormat {
  duration?: string;
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function parseFps(r?: string): number | undefined {
  if (!r) return undefined;
  const [n, d] = r.split("/").map(Number);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 1000) / 1000;
}

/** Probe a media file into an unsaved MediaAsset (no id assigned yet). */
export async function probeMedia(path: string): Promise<Omit<MediaAsset, "id">> {
  const ext = extname(path).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext) && ext !== ".gif"; // animated gif treated as video

  const { stdout } = await execFileAsync(ffprobePath(), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);

  const data = JSON.parse(stdout) as FfprobeOutput;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  const formatDuration = data.format?.duration ? Number(data.format.duration) : 0;

  let type: MediaType;
  if (isImage) type = "image";
  else if (video) type = "video";
  else type = "audio";

  const duration = type === "image" ? 0 : formatDuration || Number(video?.duration ?? audio?.duration ?? 0);

  return {
    path,
    name: basename(path),
    type,
    duration,
    width: video?.width,
    height: video?.height,
    fps: parseFps(video?.r_frame_rate),
    hasAudio: Boolean(audio),
  };
}
