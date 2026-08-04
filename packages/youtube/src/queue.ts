import { readFileSync, writeFileSync, existsSync } from "node:fs";

export type PrivacyStatus = "private" | "unlisted" | "public";
export type EntryStatus = "pending" | "uploaded" | "error";

export interface QueueEntry {
  id: string;
  videoPath: string;
  thumbnailPath?: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: PrivacyStatus;
  /** ISO datetime. Only takes effect when privacyStatus is "private" — YouTube
   *  auto-flips the video to public at this moment. */
  publishAt?: string;
  status: EntryStatus;
  youtubeVideoId?: string;
  /** True once thumbnails.set has succeeded for this video (requires a
   *  phone-verified channel — see youtube.com/verify). */
  thumbnailSet?: boolean;
  error?: string;
  addedAt: string;
  uploadedAt?: string;
  /** True once this video has been confirmed live and added to the playlist. */
  addedToPlaylist?: boolean;
  /** YouTube's actual current privacyStatus, last time it was checked — cached
   *  so the schedule view doesn't need an API call on every render. Refresh via
   *  refreshLiveStatus(). Absent until the first refresh. */
  livePrivacyStatus?: PrivacyStatus;
  /** ISO datetime this entry's live status was last checked. */
  liveCheckedAt?: string;
  /** View/like/comment counts as of liveCheckedAt — refreshed together with
   *  livePrivacyStatus (same videos.list call, no extra quota cost). */
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;

  // ── Upload-time settings (baked in from the folder's uploadDefaults when
  // added to the queue; editable per-entry before upload like title/tags) ──
  /** COPPA "made for kids" self-declaration — required by YouTube for every upload. */
  madeForKids?: boolean;
  license?: "youtube" | "creativeCommon";
  embeddable?: boolean;
  publicStatsViewable?: boolean;
  /** Whether subscribers get notified of this upload (upload-time param, not stored on the video). */
  notifySubscribers?: boolean;
}

export interface PlaylistConfig {
  title: string;
  description?: string;
  privacyStatus: PrivacyStatus;
  /** Cached once created — avoids creating a duplicate playlist on re-sync. */
  playlistId?: string;
}

/** Per-folder defaults applied to every new video when it's added to the
 *  queue (see addFolderToQueue) — lets e.g. a kids'-content channel default
 *  madeForKids to true without setting it on every single video by hand. */
export interface UploadDefaults {
  categoryId?: string;
  madeForKids?: boolean;
  license?: "youtube" | "creativeCommon";
  embeddable?: boolean;
  publicStatsViewable?: boolean;
  notifySubscribers?: boolean;
  /** Applied to every new video's description unless an explicit description
   *  is given for that add() call. `{title}` is substituted with the video's
   *  generated title — write your links/CTA/hashtags once instead of retyping
   *  them per upload. */
  descriptionTemplate?: string;
  /** If set, posted as a new top-level comment right after each upload
   *  succeeds (`{title}` substituted the same way). YouTube's API can't PIN a
   *  comment (Studio-only), so this just posts it. */
  autoCommentTemplate?: string;
}

export interface Queue {
  entries: QueueEntry[];
  /** All videos in this queue file sync to at most one playlist. */
  playlist?: PlaylistConfig;
  /** Which account (channel) this folder's videos upload to — defaults to
   *  "default" (see accounts.ts) when unset, preserving pre-multi-account setups. */
  accountId?: string;
  /** Applied to every new video added to this folder's queue — see UploadDefaults. */
  uploadDefaults?: UploadDefaults;
}

export function loadQueue(path: string): Queue {
  if (!existsSync(path)) return { entries: [] };
  return JSON.parse(readFileSync(path, "utf8")) as Queue;
}

export function saveQueue(path: string, queue: Queue): void {
  writeFileSync(path, JSON.stringify(queue, null, 2), "utf8");
}
