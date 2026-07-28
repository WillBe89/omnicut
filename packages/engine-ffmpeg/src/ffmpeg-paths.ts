/**
 * Resolves the bundled ffmpeg/ffprobe binaries. Using the -static packages
 * means the app ships self-contained — no system install required.
 *
 * When packaged inside an Electron asar archive the binaries live in
 * `app.asar.unpacked`, so we rewrite the path accordingly.
 */
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

function unpack(p: string): string {
  return p.replace("app.asar", "app.asar.unpacked");
}

export function ffmpegPath(): string {
  const p = ffmpegStatic as unknown as string | null;
  if (!p) throw new Error("ffmpeg-static did not resolve a binary path");
  return unpack(p);
}

export function ffprobePath(): string {
  const p = (ffprobeStatic as unknown as { path: string }).path;
  if (!p) throw new Error("ffprobe-static did not resolve a binary path");
  return unpack(p);
}
