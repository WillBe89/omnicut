import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIALS_DIR } from "./credentials.js";
import { loadQueue } from "./queue.js";

const REGISTRY_PATH = join(CREDENTIALS_DIR, "folders.json");

export interface KnownFolder {
  path: string;
  label: string;
  addedAt: string;
}

function loadRegistry(): KnownFolder[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as KnownFolder[];
  } catch {
    return [];
  }
}

function saveRegistry(folders: KnownFolder[]): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(folders, null, 2), "utf8");
}

export function listKnownFolders(): KnownFolder[] {
  return loadRegistry();
}

export function registerFolder(path: string, label: string): KnownFolder[] {
  const folders = loadRegistry();
  if (!folders.some((f) => f.path === path)) {
    folders.push({ path, label, addedAt: new Date().toISOString() });
    saveRegistry(folders);
  }
  return folders;
}

export function forgetFolder(path: string): KnownFolder[] {
  const folders = loadRegistry().filter((f) => f.path !== path);
  saveRegistry(folders);
  return folders;
}

/** Known folders plus a quick summary (counts, playlist) for a dashboard list. */
export function listKnownFoldersWithSummary() {
  return listKnownFolders().map((f) => {
    const q = loadQueue(join(f.path, ".youtube-queue.json"));
    const pending = q.entries.filter((e) => e.status === "pending").length;
    const uploaded = q.entries.filter((e) => e.status === "uploaded").length;
    const errored = q.entries.filter((e) => e.status === "error").length;
    return { ...f, total: q.entries.length, pending, uploaded, errored, playlist: q.playlist ?? null };
  });
}
