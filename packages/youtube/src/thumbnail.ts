/**
 * Extracts a YouTube thumbnail from a rendered music video's own clean frame 0
 * (the "Living Cover"/reactive engines deliberately leave frame 0 free of the
 * EQ/dust overlay for exactly this purpose — see engine-ffmpeg/reactive.ts).
 */
import { spawn } from "node:child_process";
import { ffmpegPath } from "@video-editor/engine-ffmpeg";

export async function extractThumbnail(videoPath: string, outputJpgPath: string): Promise<string> {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-ss", "0", "-i", videoPath,
    "-frames:v", "1", "-q:v", "2",
    "-y", outputJpgPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`thumbnail extraction failed: ${err.slice(-400)}`))));
  });
  return outputJpgPath;
}
