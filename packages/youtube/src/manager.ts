/**
 * High-level queue orchestration, shared by the CLI (scripts/youtube-queue.mjs)
 * and the OmniCut desktop app's Publish panel — one implementation, two
 * surfaces, so behavior never drifts between them.
 */
import { readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { withAccountAuth, DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { extractThumbnail } from "./thumbnail.js";
import { loadQueue, saveQueue, type Queue, type QueueEntry, type PrivacyStatus } from "./queue.js";
import { uploadVideo, setThumbnail, QuotaExceededError } from "./upload.js";
import { planPlaylistSync, runPlaylistSync, type SyncPlan } from "./sync.js";
import type { OAuth2Client } from "./auth.js";

export function queuePathFor(folder: string): string {
  return join(folder, ".youtube-queue.json");
}

export function getQueueSnapshot(folder: string): Queue {
  return loadQueue(queuePathFor(folder));
}

/** Run `fn` authorized as whichever account this folder's queue is assigned
 *  to (defaulting to "default"), holding that account's lock for the duration. */
function withFolderAuth<T>(folder: string, fn: (auth: OAuth2Client) => Promise<T>): Promise<T> {
  const queue = getQueueSnapshot(folder);
  return withAccountAuth(queue.accountId ?? DEFAULT_ACCOUNT_ID, fn);
}

function defaultMetadata(songName: string, opts: { titlePrefix?: string; description?: string } = {}) {
  const title = opts.titlePrefix ? `${opts.titlePrefix} - ${songName}` : songName;
  return {
    title,
    description: opts.description ?? title,
    tags: [songName],
  };
}

function scanVideos(folder: string): { id: string; path: string }[] {
  return readdirSync(folder)
    .filter((f) => extname(f).toLowerCase() === ".mp4")
    .map((f) => ({ id: basename(f, ".mp4"), path: join(folder, f) }));
}

export interface AddOptions {
  everyDays?: number;
  /** Explicit first publish date/time (anything `new Date()` accepts); omit to
   *  continue after the latest already-scheduled entry, or default to +24h. */
  startDate?: string;
  extraTags?: string[];
  /** Prepended as "<prefix> - <filename>" to the auto-generated title, e.g. an artist or channel name. */
  titlePrefix?: string;
  /** Overrides the auto-generated description (defaults to the title). */
  description?: string;
}

export interface AddedEntry {
  id: string;
  publishAt: string;
}

/** Scan a folder for un-queued .mp4s, extract each one's clean frame-0
 *  thumbnail, and add them with a staggered publish schedule. */
export async function addFolderToQueue(folder: string, opts: AddOptions = {}): Promise<AddedEntry[]> {
  const everyDays = opts.everyDays ?? 3;
  const extraTags = opts.extraTags ?? [];
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  const known = new Set(queue.entries.map((e) => e.id));

  const videos = scanVideos(folder).filter((v) => !known.has(v.id));
  if (videos.length === 0) return [];

  const thumbDir = join(folder, ".thumbnails");
  mkdirSync(thumbDir, { recursive: true });

  let cursor = opts.startDate ? new Date(opts.startDate) : new Date(Date.now() + 24 * 3600 * 1000);
  const scheduled = queue.entries.map((e) => e.publishAt).filter((x): x is string => Boolean(x)).sort();
  if (!opts.startDate && scheduled.length > 0) {
    cursor = new Date(new Date(scheduled[scheduled.length - 1]!).getTime() + everyDays * 24 * 3600 * 1000);
  }

  const added: AddedEntry[] = [];
  for (const v of videos) {
    const thumbPath = join(thumbDir, `${v.id}.jpg`);
    await extractThumbnail(v.path, thumbPath);
    const meta = defaultMetadata(v.id, { titlePrefix: opts.titlePrefix, description: opts.description });
    const publishAt = cursor.toISOString();
    queue.entries.push({
      id: v.id,
      videoPath: v.path,
      thumbnailPath: thumbPath,
      title: meta.title,
      description: meta.description,
      tags: [...meta.tags, ...extraTags],
      categoryId: "10",
      privacyStatus: "private",
      publishAt,
      status: "pending",
      addedAt: new Date().toISOString(),
    });
    added.push({ id: v.id, publishAt });
    cursor = new Date(cursor.getTime() + everyDays * 24 * 3600 * 1000);
  }
  saveQueue(queuePath, queue);
  return added;
}

export type UploadProgressEvent =
  | { kind: "uploading"; id: string }
  | { kind: "done"; id: string; videoId: string }
  | { kind: "error"; id: string; error: string }
  | { kind: "quota"; uploaded: number; total: number };

export interface RunResult {
  uploaded: number;
  total: number;
  quotaHit: boolean;
}

/** Upload every pending entry, persisting progress after each one so a partial
 *  run (quota exhausted, crash, etc.) always resumes cleanly next time. */
export async function runQueueUploads(
  folder: string,
  opts: { limit?: number; onProgress?: (e: UploadProgressEvent) => void } = {},
): Promise<RunResult> {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  const pending = queue.entries.filter((e) => e.status === "pending").slice(0, opts.limit ?? Infinity);
  if (pending.length === 0) return { uploaded: 0, total: 0, quotaHit: false };

  return withFolderAuth(folder, async (auth) => {
    let uploaded = 0;
    for (const entry of pending) {
      opts.onProgress?.({ kind: "uploading", id: entry.id });
      try {
        const { videoId, thumbnailSet } = await uploadVideo(auth, entry);
        entry.status = "uploaded";
        entry.youtubeVideoId = videoId;
        entry.thumbnailSet = thumbnailSet;
        entry.uploadedAt = new Date().toISOString();
        saveQueue(queuePath, queue);
        uploaded++;
        opts.onProgress?.({ kind: "done", id: entry.id, videoId });
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          opts.onProgress?.({ kind: "quota", uploaded, total: pending.length });
          return { uploaded, total: pending.length, quotaHit: true };
        }
        entry.status = "error";
        entry.error = (err as Error).message;
        saveQueue(queuePath, queue);
        opts.onProgress?.({ kind: "error", id: entry.id, error: (err as Error).message });
      }
    }
    return { uploaded, total: pending.length, quotaHit: false };
  });
}

export interface ThumbResult {
  fixed: number;
  total: number;
  quotaHit: boolean;
}

/** Retry thumbnails.set for every uploaded video that doesn't have one yet —
 *  the common cause is an unverified channel (see youtube.com/verify). */
export async function retryQueueThumbnails(
  folder: string,
  onProgress?: (e: { id: string; ok: boolean; error?: string }) => void,
): Promise<ThumbResult> {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  const targets = queue.entries.filter((e) => e.status === "uploaded" && e.thumbnailPath && !e.thumbnailSet);
  if (targets.length === 0) return { fixed: 0, total: 0, quotaHit: false };

  return withFolderAuth(folder, async (auth) => {
    let fixed = 0;
    for (const entry of targets) {
      try {
        await setThumbnail(auth, entry.youtubeVideoId!, entry.thumbnailPath!);
        entry.thumbnailSet = true;
        saveQueue(queuePath, queue);
        fixed++;
        onProgress?.({ id: entry.id, ok: true });
      } catch (err) {
        if (err instanceof QuotaExceededError) return { fixed, total: targets.length, quotaHit: true };
        onProgress?.({ id: entry.id, ok: false, error: (err as Error).message });
      }
    }
    return { fixed, total: targets.length, quotaHit: false };
  });
}

/** Assign which account (channel) a folder's uploads/sync should use. */
export function setQueueAccount(folder: string, accountId: string): void {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  queue.accountId = accountId;
  saveQueue(queuePath, queue);
}

export function setQueuePlaylist(
  folder: string,
  config: { title: string; description?: string; privacyStatus: PrivacyStatus },
): void {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  queue.playlist = {
    title: config.title,
    description: config.description ?? "",
    privacyStatus: config.privacyStatus,
    playlistId: queue.playlist?.playlistId,
  };
  saveQueue(queuePath, queue);
}

export async function previewPlaylistSync(folder: string): Promise<SyncPlan> {
  const queue = getQueueSnapshot(folder);
  if (!queue.playlist) return { playlistId: null, toAdd: [], notLiveYet: [] };
  return withFolderAuth(folder, (auth) => planPlaylistSync(auth, queue));
}

/** Patch a single entry's editable fields (title, description, tags,
 *  publishAt, privacyStatus) — used by the GUI's schedule/metadata editor.
 *  Only meaningful before upload; already-uploaded videos' metadata must be
 *  changed on YouTube directly (out of scope here). */
export function updateQueueEntry(
  folder: string,
  entryId: string,
  patch: Partial<Pick<QueueEntry, "title" | "description" | "tags" | "publishAt" | "privacyStatus">>,
): QueueEntry {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  const entry = queue.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`No queue entry "${entryId}" in ${folder}`);
  Object.assign(entry, patch);
  saveQueue(queuePath, queue);
  return entry;
}

/** Re-stagger every still-pending entry's publishAt starting from a given
 *  date, `everyDays` apart, in their current queue order — for "I moved the
 *  whole release calendar" type edits without retyping each date by hand. */
export function rescheduleQueue(folder: string, startDate: string, everyDays: number): QueueEntry[] {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  let cursor = new Date(startDate);
  const touched: QueueEntry[] = [];
  for (const entry of queue.entries) {
    if (entry.status !== "pending") continue; // don't rewrite already-live videos
    entry.publishAt = cursor.toISOString();
    touched.push(entry);
    cursor = new Date(cursor.getTime() + everyDays * 24 * 3600 * 1000);
  }
  saveQueue(queuePath, queue);
  return touched;
}

export function removeQueueEntry(folder: string, entryId: string): void {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  const entry = queue.entries.find((e) => e.id === entryId);
  if (entry && entry.status === "uploaded") {
    throw new Error("Can't remove an already-uploaded entry from the queue (it's live on YouTube).");
  }
  queue.entries = queue.entries.filter((e) => e.id !== entryId);
  saveQueue(queuePath, queue);
}

export interface SyncOutcome {
  playlistId: string;
  added: QueueEntry[];
  quotaHit: boolean;
}

export interface FolderRunResult {
  folder: string;
  upload: RunResult;
  sync?: SyncOutcome;
  error?: string;
}

/**
 * Upload pending videos + sync playlists for every given folder AT ONCE.
 * Safe to run concurrently: folders on the SAME account queue behind each
 * other automatically (see accounts.ts's per-account mutex+lock), while
 * folders on DIFFERENT accounts genuinely run in parallel — so e.g. your
 * music channel and a kids'-books channel never wait on one another.
 */
export async function runAllFolders(
  folders: string[],
  onProgress?: (folder: string, e: UploadProgressEvent) => void,
): Promise<FolderRunResult[]> {
  return Promise.all(
    folders.map(async (folder): Promise<FolderRunResult> => {
      try {
        const upload = await runQueueUploads(folder, { onProgress: (e) => onProgress?.(folder, e) });
        let sync: SyncOutcome | undefined;
        if (getQueueSnapshot(folder).playlist) sync = await syncQueuePlaylist(folder);
        return { folder, upload, sync };
      } catch (err) {
        return { folder, upload: { uploaded: 0, total: 0, quotaHit: false }, error: (err as Error).message };
      }
    }),
  );
}

export async function syncQueuePlaylist(
  folder: string,
  onProgress?: (msg: string) => void,
): Promise<SyncOutcome> {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  if (!queue.playlist) throw new Error("No playlist configured for this folder.");
  return withFolderAuth(folder, async (auth) => {
    try {
      const { playlistId, added } = await runPlaylistSync(auth, queue, onProgress);
      saveQueue(queuePath, queue);
      return { playlistId, added, quotaHit: false };
    } catch (err) {
      saveQueue(queuePath, queue); // persist partial progress (playlistId, addedToPlaylist flags)
      if (err instanceof QuotaExceededError) return { playlistId: queue.playlist!.playlistId ?? "", added: [], quotaHit: true };
      throw err;
    }
  });
}
