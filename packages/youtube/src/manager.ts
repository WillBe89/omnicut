/**
 * High-level queue orchestration, shared by the CLI (scripts/youtube-queue.mjs)
 * and the OmniCut desktop app's Publish panel — one implementation, two
 * surfaces, so behavior never drifts between them.
 */
import { readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { withAccountAuth, DEFAULT_ACCOUNT_ID, listAccounts, getAccount } from "./accounts.js";
import { extractThumbnail } from "./thumbnail.js";
import { loadQueue, saveQueue, type Queue, type QueueEntry, type PrivacyStatus, type UploadDefaults } from "./queue.js";
import { uploadVideo, setThumbnail, updateLiveVideo, QuotaExceededError } from "./upload.js";
import { planPlaylistSync, runPlaylistSync, type SyncPlan } from "./sync.js";
import { fetchLiveStatus } from "./playlists.js";
import { listKnownFolders } from "./registry.js";
import { fetchVideoAnalytics, fetchTrafficSources, fetchChannelAnalytics, type VideoAnalytics, type TrafficSource } from "./analytics.js";
import { recordChannelSnapshot, getChannelTrend } from "./channelhealth.js";
import { listTopComments, postComment, replyToComment, type CommentSummary } from "./comments.js";
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

function applyTemplate(template: string, vars: { title: string }): string {
  return template.replace(/\{title\}/g, vars.title);
}

function defaultMetadata(songName: string, opts: { titlePrefix?: string; description?: string; descriptionTemplate?: string } = {}) {
  const title = opts.titlePrefix ? `${opts.titlePrefix} - ${songName}` : songName;
  const description = opts.description ?? (opts.descriptionTemplate ? applyTemplate(opts.descriptionTemplate, { title }) : title);
  return { title, description, tags: [songName] };
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

  const defaults = queue.uploadDefaults ?? {};
  const added: AddedEntry[] = [];
  for (const v of videos) {
    const thumbPath = join(thumbDir, `${v.id}.jpg`);
    await extractThumbnail(v.path, thumbPath);
    const meta = defaultMetadata(v.id, { titlePrefix: opts.titlePrefix, description: opts.description, descriptionTemplate: defaults.descriptionTemplate });
    const publishAt = cursor.toISOString();
    queue.entries.push({
      id: v.id,
      videoPath: v.path,
      thumbnailPath: thumbPath,
      title: meta.title,
      description: meta.description,
      tags: [...meta.tags, ...extraTags],
      categoryId: defaults.categoryId ?? "10",
      privacyStatus: "private",
      publishAt,
      status: "pending",
      addedAt: new Date().toISOString(),
      madeForKids: defaults.madeForKids,
      license: defaults.license,
      embeddable: defaults.embeddable,
      publicStatsViewable: defaults.publicStatsViewable,
      notifySubscribers: defaults.notifySubscribers,
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
        if (queue.uploadDefaults?.autoCommentTemplate) {
          // Best-effort: a failed auto-comment shouldn't fail the upload itself.
          try { await postComment(auth, videoId, applyTemplate(queue.uploadDefaults.autoCommentTemplate, { title: entry.title })); }
          catch (err) { opts.onProgress?.({ kind: "error", id: entry.id, error: `Uploaded, but auto-comment failed: ${(err as Error).message}` }); }
        }
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

export type QueueEntryPatch = Partial<Pick<QueueEntry,
  "title" | "description" | "tags" | "publishAt" | "privacyStatus" | "categoryId" |
  "madeForKids" | "license" | "embeddable" | "publicStatsViewable"
>>;

/** Patch a queue entry's editable fields. Always updates the local record;
 *  if the video has ALREADY been uploaded, also pushes the same fields to
 *  YouTube itself (videos.update) — so editing works identically whether a
 *  video is still pending or already live, instead of forcing a trip to
 *  YouTube directly to fix a typo after the fact. */
export async function updateQueueEntry(folder: string, entryId: string, patch: QueueEntryPatch): Promise<QueueEntry> {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  const entry = queue.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`No queue entry "${entryId}" in ${folder}`);
  Object.assign(entry, patch);
  saveQueue(queuePath, queue);

  if (entry.status === "uploaded" && entry.youtubeVideoId) {
    const { title, description, tags, categoryId, privacyStatus, publishAt, madeForKids, license, embeddable, publicStatsViewable } = patch;
    await withFolderAuth(folder, (auth) =>
      updateLiveVideo(auth, entry.youtubeVideoId!, { title, description, tags, categoryId, privacyStatus, publishAt, madeForKids, license, embeddable, publicStatsViewable }));
  }
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

/** Ask YouTube for the REAL current privacyStatus AND view/like/comment
 *  counts of every uploaded video in this folder, caching them on each entry
 *  (livePrivacyStatus/viewCount/likeCount/commentCount/liveCheckedAt), so the
 *  schedule/queue views can show "actually public" vs. "still scheduled" plus
 *  live stats without hitting the API on every render. */
export async function refreshLiveStatus(folder: string): Promise<QueueEntry[]> {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  const targets = queue.entries.filter((e) => e.status === "uploaded" && e.youtubeVideoId);
  if (targets.length === 0) return [];

  return withFolderAuth(folder, async (auth) => {
    const live = await fetchLiveStatus(auth, targets.map((e) => e.youtubeVideoId!));
    const checkedAt = new Date().toISOString();
    const touched: QueueEntry[] = [];
    for (const entry of targets) {
      const status = live.get(entry.youtubeVideoId!);
      if (status) {
        entry.livePrivacyStatus = status.privacyStatus;
        entry.viewCount = status.viewCount;
        entry.likeCount = status.likeCount;
        entry.commentCount = status.commentCount;
        entry.liveCheckedAt = checkedAt;
        touched.push(entry);
      }
    }
    saveQueue(queuePath, queue);
    // Best-effort: a snapshot failure shouldn't fail the video-status refresh itself.
    try { await recordChannelSnapshot(queue.accountId ?? DEFAULT_ACCOUNT_ID, auth); } catch { /* channel health is a bonus, not critical */ }
    return touched;
  });
}

export interface EntryAnalytics {
  analytics: VideoAnalytics | null;
  trafficSources: TrafficSource[];
}

/** Real YouTube Analytics for one queue entry — watch time, retention,
 *  subscriber deltas, and where its views actually came from. Requires the
 *  folder's account to have granted the Analytics scope (see
 *  reauthorizeAccount in accounts.ts) — throws AnalyticsScopeError if not. */
export async function getVideoAnalytics(folder: string, entryId: string): Promise<EntryAnalytics> {
  const queue = getQueueSnapshot(folder);
  const entry = queue.entries.find((e) => e.id === entryId);
  if (!entry?.youtubeVideoId) throw new Error(`"${entryId}" hasn't been uploaded yet — no analytics to show.`);
  return withFolderAuth(folder, async (auth) => {
    const [analytics, trafficSources] = await Promise.all([
      fetchVideoAnalytics(auth, entry.youtubeVideoId!),
      fetchTrafficSources(auth, entry.youtubeVideoId!),
    ]);
    return { analytics, trafficSources };
  });
}

/** Top comments on one queue entry's video (empty array if comments are off — not an error). */
export async function getEntryComments(folder: string, entryId: string): Promise<CommentSummary[]> {
  const queue = getQueueSnapshot(folder);
  const entry = queue.entries.find((e) => e.id === entryId);
  if (!entry?.youtubeVideoId) throw new Error(`"${entryId}" hasn't been uploaded yet — no comments to show.`);
  return withFolderAuth(folder, (auth) => listTopComments(auth, entry.youtubeVideoId!));
}

/** Post a new top-level comment on one queue entry's video (e.g. links/CTA). */
export async function postEntryComment(folder: string, entryId: string, text: string): Promise<string> {
  const queue = getQueueSnapshot(folder);
  const entry = queue.entries.find((e) => e.id === entryId);
  if (!entry?.youtubeVideoId) throw new Error(`"${entryId}" hasn't been uploaded yet.`);
  return withFolderAuth(folder, (auth) => postComment(auth, entry.youtubeVideoId!, text));
}

/** Reply to an existing comment thread on one of this folder's videos. */
export async function replyToEntryComment(folder: string, parentCommentId: string, text: string): Promise<string> {
  return withFolderAuth(folder, (auth) => replyToComment(auth, parentCommentId, text));
}

/** Set this folder's per-video upload defaults (category, made-for-kids,
 *  license, etc.) — applied to every new video the next time it's added to
 *  the queue via addFolderToQueue. Doesn't retroactively change videos
 *  already queued or uploaded. */
export function setUploadDefaults(folder: string, defaults: UploadDefaults): void {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  queue.uploadDefaults = { ...queue.uploadDefaults, ...defaults };
  saveQueue(queuePath, queue);
}

export interface BulkEditPatch {
  addTags?: string[];
  removeTags?: string[];
  categoryId?: string;
  privacyStatus?: PrivacyStatus;
  madeForKids?: boolean;
  license?: "youtube" | "creativeCommon";
  embeddable?: boolean;
  publicStatsViewable?: boolean;
}

export interface BulkEditResult {
  updated: string[];
  failed: { id: string; error: string }[];
  quotaHit: boolean;
}

/** Apply the same change (add/remove a tag, change category/privacy/etc.)
 *  across many ALREADY-UPLOADED videos in a folder at once — e.g. retagging
 *  a whole back-catalog, or flipping madeForKids channel-wide. Each video is
 *  a separate videos.update call (50 quota units apiece), so a big batch can
 *  legitimately hit the daily quota — that's reported back, not swallowed,
 *  same as every other bulk operation in this file. */
export async function bulkUpdateEntries(
  folder: string,
  entryIds: string[],
  patch: BulkEditPatch,
  onProgress?: (id: string) => void,
): Promise<BulkEditResult> {
  const queuePath = queuePathFor(folder);
  const queue = loadQueue(queuePath);
  const idSet = new Set(entryIds);
  const targets = queue.entries.filter((e) => idSet.has(e.id) && e.status === "uploaded" && e.youtubeVideoId);
  const updated: string[] = [];
  const failed: { id: string; error: string }[] = [];
  if (targets.length === 0) return { updated, failed, quotaHit: false };

  return withFolderAuth(folder, async (auth) => {
    for (const entry of targets) {
      onProgress?.(entry.id);
      const nextTags = patch.addTags || patch.removeTags
        ? [...new Set([...entry.tags, ...(patch.addTags ?? [])])].filter((t) => !(patch.removeTags ?? []).includes(t))
        : undefined;
      try {
        await updateLiveVideo(auth, entry.youtubeVideoId!, {
          tags: nextTags,
          categoryId: patch.categoryId,
          privacyStatus: patch.privacyStatus,
          madeForKids: patch.madeForKids,
          license: patch.license,
          embeddable: patch.embeddable,
          publicStatsViewable: patch.publicStatsViewable,
        });
        if (nextTags) entry.tags = nextTags;
        if (patch.categoryId !== undefined) entry.categoryId = patch.categoryId;
        if (patch.privacyStatus !== undefined) entry.privacyStatus = patch.privacyStatus;
        if (patch.madeForKids !== undefined) entry.madeForKids = patch.madeForKids;
        if (patch.license !== undefined) entry.license = patch.license;
        if (patch.embeddable !== undefined) entry.embeddable = patch.embeddable;
        if (patch.publicStatsViewable !== undefined) entry.publicStatsViewable = patch.publicStatsViewable;
        saveQueue(queuePath, queue);
        updated.push(entry.id);
      } catch (err) {
        if (err instanceof QuotaExceededError) return { updated, failed, quotaHit: true };
        failed.push({ id: entry.id, error: (err as Error).message });
      }
    }
    return { updated, failed, quotaHit: false };
  });
}

export interface ScheduleItem {
  folder: string;
  folderLabel: string;
  entry: QueueEntry;
}

/** One combined, chronologically-sorted release schedule across every
 *  registered folder — reads local queue files only (no API calls, no
 *  quota cost), so it's cheap to refresh on every panel open. */
export function getUnifiedSchedule(): ScheduleItem[] {
  const items: ScheduleItem[] = [];
  for (const f of listKnownFolders()) {
    const queue = getQueueSnapshot(f.path);
    for (const entry of queue.entries) items.push({ folder: f.path, folderLabel: f.label, entry });
  }
  items.sort((a, b) => {
    const da = a.entry.publishAt ? new Date(a.entry.publishAt).getTime() : Infinity;
    const db = b.entry.publishAt ? new Date(b.entry.publishAt).getTime() : Infinity;
    return da - db;
  });
  return items;
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

export interface ChannelDashboardData {
  accountId: string;
  accountLabel: string;
  channelTitle?: string;
  /** Lifetime-to-date totals, from the most recent recorded snapshot (see channelhealth.ts). Null until "Refresh from YouTube" has run at least once. */
  lifetime: { date: string; subscriberCount: number; viewCount: number; videoCount: number } | null;
  /** Last 28 days (YouTube Studio's own default comparison window) — real Analytics API data. Null if the account hasn't granted Analytics access yet. */
  last28Days: VideoAnalytics | null;
  /** Views/subscribers gained in the last 7 recorded days vs. the 7 before — from local snapshot history, no extra API call. */
  weekTrend: { views: number; subscribers: number } | null;
  /** Set when this account's dashboard data couldn't be fetched (e.g. AnalyticsScopeError/AnalyticsApiDisabledError) — other fields still reflect whatever WAS available (lifetime/weekTrend are local, so they're often still present even if last28Days failed). */
  error?: string;
}

/** One account's full dashboard: lifetime totals + a real 28-day Analytics
 *  window + the local week-over-week trend — everything needed to judge
 *  "how is this channel doing" at a glance, comparable across accounts. */
export async function getChannelDashboard(accountId: string): Promise<ChannelDashboardData> {
  const account = getAccount(accountId);
  if (!account) throw new Error(`Unknown account "${accountId}".`);
  const trend = getChannelTrend(accountId);
  const base: ChannelDashboardData = {
    accountId,
    accountLabel: account.label,
    channelTitle: account.channelTitle,
    lifetime: trend.latest,
    last28Days: null,
    weekTrend: trend.last7Days,
  };
  try {
    const last28Days = await withAccountAuth(accountId, (auth) => fetchChannelAnalytics(auth, 28));
    return { ...base, last28Days };
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
}

/** Every registered account's dashboard data, fetched concurrently — one
 *  account's Analytics error (not yet re-authorized, API not enabled, etc.)
 *  doesn't block the others from showing. */
export async function getAllChannelDashboards(): Promise<ChannelDashboardData[]> {
  return Promise.all(listAccounts().map((a) => getChannelDashboard(a.id)));
}
