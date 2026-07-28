import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { ffmpegPath } from "./ffmpeg-paths.js";

export interface FfmpegProgress {
  fraction: number; // 0..1
  outTime: number; // seconds rendered
  duration: number; // total seconds
  speed?: string;
}

export interface RunOptions {
  duration: number;
  onProgress?: (p: FfmpegProgress) => void;
  onCommand?: (cmd: string) => void;
  signal?: AbortSignal;
  /** When set, called with ffmpeg's stdin so the caller can stream a raw-video
   *  input (e.g. `-i pipe:0`). Must write frames and end() the stream. */
  feedStdin?: (stdin: Writable) => Promise<void>;
}

function parseTimecode(tc: string): number {
  const parts = tc.trim().split(":").map(Number);
  if (parts.some(Number.isNaN)) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function parseProgressBlock(chunk: string, duration: number): FfmpegProgress | null {
  let usFromMicros: number | undefined;
  let secFromTimecode: number | undefined;
  let speed: string | undefined;
  for (const line of chunk.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    // ffmpeg's out_time_us and (misnamed) out_time_ms are both microseconds;
    // prefer out_time_us, else the unambiguous out_time timecode.
    if (key === "out_time_us") {
      const n = Number(value);
      if (!Number.isNaN(n)) usFromMicros = n / 1_000_000;
    } else if (key === "out_time") {
      const n = parseTimecode(value);
      if (!Number.isNaN(n)) secFromTimecode = n;
    } else if (key === "speed") {
      speed = value.trim();
    }
  }
  const outTime = usFromMicros ?? secFromTimecode;
  if (outTime === undefined) return null;
  return { outTime, duration, speed, fraction: Math.max(0, Math.min(1, outTime / duration)) };
}

/** Spawn ffmpeg with the given args, streaming progress and surfacing errors. */
export async function runFfmpeg(args: string[], opts: RunOptions): Promise<void> {
  const fullArgs = ["-progress", "pipe:1", "-nostats", ...args];
  opts.onCommand?.(`ffmpeg ${fullArgs.join(" ")}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath(), fullArgs, { windowsHide: true });
    let stderrTail = "";
    let stdoutBuf = "";

    const onAbort = () => child.kill("SIGKILL");
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (opts.feedStdin) {
      opts.feedStdin(child.stdin).catch((err) => {
        child.kill("SIGKILL");
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    }

    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      const blocks = stdoutBuf.split("progress=");
      stdoutBuf = blocks.pop() ?? "";
      for (const block of blocks) {
        const p = parseProgressBlock(block, opts.duration);
        if (p) opts.onProgress?.(p);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail += d.toString();
      if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        opts.onProgress?.({ fraction: 1, outTime: opts.duration, duration: opts.duration });
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}.\n--- ffmpeg log (tail) ---\n${stderrTail.trim()}`));
      }
    });
  });
}
