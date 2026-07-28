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
}

export interface PlaylistConfig {
  title: string;
  description?: string;
  privacyStatus: PrivacyStatus;
  /** Cached once created — avoids creating a duplicate playlist on re-sync. */
  playlistId?: string;
}

export interface Queue {
  entries: QueueEntry[];
  /** All videos in this queue file sync to at most one playlist. */
  playlist?: PlaylistConfig;
  /** Which account (channel) this folder's videos upload to — defaults to
   *  "default" (see accounts.ts) when unset, preserving pre-multi-account setups. */
  accountId?: string;
}

export function loadQueue(path: string): Queue {
  if (!existsSync(path)) return { entries: [] };
  return JSON.parse(readFileSync(path, "utf8")) as Queue;
}

export function saveQueue(path: string, queue: Queue): void {
  writeFileSync(path, JSON.stringify(queue, null, 2), "utf8");
}
