/**
 * Windows Task Scheduler integration for "run this on a timer" — registers a
 * real OS-level scheduled task that runs scripts/youtube-autorun.mjs daily,
 * so uploads/playlist-sync happen even when OmniCut isn't open. Uses `node`
 * on PATH (the same command the user could type themselves), not an Electron
 * subprocess trick — keeps it transparent and debuggable.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// esbuild bundles this module INTO dist/main.js, so __dirname here is
// apps/desktop/dist at runtime — same 3-levels-up depth main.ts already uses
// for MCP_SERVER_PATH, not a separate file's own directory.
const AUTORUN_SCRIPT = join(__dirname, "..", "..", "..", "scripts", "youtube-autorun.mjs");

function taskName(folder: string): string {
  let h = 0;
  for (const c of folder) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `OmniCut_YTSync_${Math.abs(h).toString(16)}`;
}

export interface AutoSyncStatus {
  enabled: boolean;
  time?: string;
  nextRun?: string;
}

/** Register (or update the time of) a daily scheduled task for this folder. */
export async function enableAutoSync(folder: string, time: string): Promise<void> {
  const name = taskName(folder);
  const cmd = `node "${AUTORUN_SCRIPT}" "${folder}"`;
  await execFileAsync("schtasks", ["/create", "/tn", name, "/tr", cmd, "/sc", "daily", "/st", time, "/f"]);
}

export async function disableAutoSync(folder: string): Promise<void> {
  const name = taskName(folder);
  try {
    await execFileAsync("schtasks", ["/delete", "/tn", name, "/f"]);
  } catch {
    /* already absent — fine */
  }
}

export async function getAutoSyncStatus(folder: string): Promise<AutoSyncStatus> {
  const name = taskName(folder);
  try {
    const { stdout } = await execFileAsync("schtasks", ["/query", "/tn", name, "/fo", "LIST"]);
    const nextRun = /Next Run Time:\s*(.+)/.exec(stdout)?.[1]?.trim();
    const startTime = /Start Time:\s*(.+)/.exec(stdout)?.[1]?.trim();
    return { enabled: true, nextRun, time: startTime };
  } catch {
    return { enabled: false };
  }
}

/** Trigger the scheduled task immediately (a "test it now" button) — runs the
 *  exact same command the daily schedule would, via Task Scheduler itself. */
export async function runAutoSyncNow(folder: string): Promise<void> {
  const name = taskName(folder);
  await execFileAsync("schtasks", ["/run", "/tn", name]);
}
