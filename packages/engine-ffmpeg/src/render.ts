import { mkdir, writeFile, rm } from "node:fs/promises";
import type { Project } from "@video-editor/core";
import { compileTimeline } from "./compile.js";
import { runFfmpeg, type FfmpegProgress } from "./run.js";

export type RenderProgress = FfmpegProgress;

export interface RenderOptions {
  /** Where to write drawtext temp files. Defaults to a sibling of the output. */
  workDir: string;
  onProgress?: (p: RenderProgress) => void;
  /** Abort a running render. */
  signal?: AbortSignal;
  /** Log the exact ffmpeg command (debugging). */
  onCommand?: (cmd: string) => void;
}

export interface RenderResult {
  outputPath: string;
  duration: number;
}

/** Compile the timeline and render it to `outputPath` with FFmpeg. */
export async function renderProject(
  project: Project,
  outputPath: string,
  options: RenderOptions,
): Promise<RenderResult> {
  const compiled = compileTimeline(project, outputPath, options.workDir);

  await mkdir(options.workDir, { recursive: true });
  for (const f of compiled.tempFiles) {
    await writeFile(f.path, f.content, "utf8");
  }

  try {
    await runFfmpeg(compiled.args, {
      duration: compiled.duration,
      onProgress: options.onProgress,
      onCommand: options.onCommand,
      signal: options.signal,
    });
  } finally {
    await Promise.all(compiled.tempFiles.map((f) => rm(f.path, { force: true }).catch(() => {})));
  }
  return { outputPath, duration: compiled.duration };
}
