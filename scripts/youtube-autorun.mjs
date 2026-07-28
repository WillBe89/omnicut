#!/usr/bin/env node
/**
 * Headless runner invoked by a Windows Scheduled Task (see
 * apps/desktop/src/main/scheduler.ts) — uploads pending videos then syncs the
 * playlist for one folder, or every registered folder (run concurrently —
 * different accounts truly run in parallel, same-account folders safely
 * queue behind each other) if none is given. Silent by design (logs to a
 * file, not a terminal, since nobody's watching).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAllFolders, listKnownFolders, CREDENTIALS_DIR } from "@video-editor/youtube";

const logPath = join(CREDENTIALS_DIR, "autorun.log");
mkdirSync(CREDENTIALS_DIR, { recursive: true });
function log(msg) {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
}

const target = process.argv[2];
const folders = target ? [target] : listKnownFolders().map((f) => f.path);

const results = await runAllFolders(folders);
for (const r of results) {
  if (r.error) { log(`${r.folder}: ERROR ${r.error}`); continue; }
  log(`${r.folder}: uploaded ${r.upload.uploaded}/${r.upload.total}${r.upload.quotaHit ? " (quota hit)" : ""}`
    + (r.sync ? ` — playlist +${r.sync.added.length}${r.sync.quotaHit ? " (quota hit)" : ""}` : ""));
}
