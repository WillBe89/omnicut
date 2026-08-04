import type { OAuth2Client } from "./auth.js";
import type { Queue, QueueEntry } from "./queue.js";
import { getOrCreatePlaylist, listPlaylistVideoIds, addVideoToPlaylist, fetchLiveStatus } from "./playlists.js";

export interface SyncPlan {
  playlistId: string | null;
  /** Entries that would be added to the playlist this run. */
  toAdd: QueueEntry[];
  /** Entries still private/scheduled — not live yet, correctly skipped. */
  notLiveYet: QueueEntry[];
}

/** Decide what a sync WOULD do, without making any changes — checks each
 *  uploaded video's REAL current status (not the possibly-stale local record)
 *  so a scheduled video that has since gone public is picked up correctly. */
export async function planPlaylistSync(auth: OAuth2Client, queue: Queue): Promise<SyncPlan> {
  if (!queue.playlist) return { playlistId: null, toAdd: [], notLiveYet: [] };

  const candidates = queue.entries.filter(
    (e) => e.status === "uploaded" && e.youtubeVideoId && !e.addedToPlaylist,
  );
  if (candidates.length === 0) return { playlistId: queue.playlist.playlistId ?? null, toAdd: [], notLiveYet: [] };

  const live = await fetchLiveStatus(auth, candidates.map((e) => e.youtubeVideoId!));
  const toAdd: QueueEntry[] = [];
  const notLiveYet: QueueEntry[] = [];
  for (const e of candidates) {
    if (live.get(e.youtubeVideoId!)?.privacyStatus === "public") toAdd.push(e);
    else notLiveYet.push(e);
  }
  return { playlistId: queue.playlist.playlistId ?? null, toAdd, notLiveYet };
}

/** Execute a sync: ensure the playlist exists, add every now-live video that
 *  isn't in it yet, and mark those entries in the queue (caller persists). */
export async function runPlaylistSync(
  auth: OAuth2Client,
  queue: Queue,
  onProgress?: (msg: string) => void,
): Promise<{ playlistId: string; added: QueueEntry[] }> {
  if (!queue.playlist) throw new Error("No playlist configured for this queue.");

  const playlistId =
    queue.playlist.playlistId ??
    (await getOrCreatePlaylist(auth, queue.playlist.title, queue.playlist.description ?? "", queue.playlist.privacyStatus));
  queue.playlist.playlistId = playlistId;

  const plan = await planPlaylistSync(auth, queue);
  const alreadyIn = await listPlaylistVideoIds(auth, playlistId);

  const added: QueueEntry[] = [];
  for (const entry of plan.toAdd) {
    if (alreadyIn.has(entry.youtubeVideoId!)) {
      entry.addedToPlaylist = true;
      continue;
    }
    onProgress?.(`Adding "${entry.title}" to playlist…`);
    await addVideoToPlaylist(auth, playlistId, entry.youtubeVideoId!);
    entry.addedToPlaylist = true;
    added.push(entry);
  }
  return { playlistId, added };
}
