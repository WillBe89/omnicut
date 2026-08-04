import { google } from "googleapis";
import type { OAuth2Client } from "./auth.js";
import type { PrivacyStatus } from "./queue.js";
import { QuotaExceededError } from "./upload.js";

function isQuotaError(err: unknown): boolean {
  const e = err as { code?: number; errors?: { reason?: string }[]; message?: string };
  if (e?.code !== 403) return false;
  const reason = e.errors?.[0]?.reason ?? "";
  return reason === "quotaExceeded" || reason === "dailyLimitExceeded" || /quota/i.test(e.message ?? "");
}

export interface PlaylistSummary {
  id: string;
  title: string;
}

/** List playlists owned by the authorized channel. */
export async function listMyPlaylists(auth: OAuth2Client): Promise<PlaylistSummary[]> {
  const youtube = google.youtube({ version: "v3", auth });
  const out: PlaylistSummary[] = [];
  let pageToken: string | undefined;
  do {
    const res = await youtube.playlists.list({ part: ["snippet"], mine: true, maxResults: 50, pageToken });
    for (const item of res.data.items ?? []) {
      if (item.id && item.snippet?.title) out.push({ id: item.id, title: item.snippet.title });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/** Find an existing playlist by exact title, or create one. Idempotent. */
export async function getOrCreatePlaylist(
  auth: OAuth2Client,
  title: string,
  description: string,
  privacyStatus: PrivacyStatus,
): Promise<string> {
  const youtube = google.youtube({ version: "v3", auth });
  const existing = (await listMyPlaylists(auth)).find((p) => p.title === title);
  if (existing) return existing.id;

  try {
    const res = await youtube.playlists.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description },
        status: { privacyStatus },
      },
    });
    return res.data.id!;
  } catch (err) {
    if (isQuotaError(err)) throw new QuotaExceededError((err as Error).message);
    throw err;
  }
}

/** Video IDs already present in a playlist (to avoid duplicate adds). */
export async function listPlaylistVideoIds(auth: OAuth2Client, playlistId: string): Promise<Set<string>> {
  const youtube = google.youtube({ version: "v3", auth });
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const res = await youtube.playlistItems.list({
      part: ["contentDetails"], playlistId, maxResults: 50, pageToken,
    });
    for (const item of res.data.items ?? []) {
      if (item.contentDetails?.videoId) ids.add(item.contentDetails.videoId);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

export async function addVideoToPlaylist(auth: OAuth2Client, playlistId: string, videoId: string): Promise<void> {
  const youtube = google.youtube({ version: "v3", auth });
  try {
    await youtube.playlistItems.insert({
      part: ["snippet"],
      requestBody: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
    });
  } catch (err) {
    if (isQuotaError(err)) throw new QuotaExceededError((err as Error).message);
    throw err;
  }
}

export interface VideoStatus {
  privacyStatus: PrivacyStatus;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
}

/** Real, current status AND stats of videos in one call (our local
 *  queue.json's privacyStatus can be stale once YouTube auto-flips a
 *  scheduled video to public server-side; view/like/comment counts are
 *  never cached locally except by whoever calls this). videos.list costs a
 *  flat 1 quota unit per up-to-50-id batch regardless of how many parts
 *  are requested, so bundling stats in here is free. */
export async function fetchLiveStatus(auth: OAuth2Client, videoIds: string[]): Promise<Map<string, VideoStatus>> {
  const youtube = google.youtube({ version: "v3", auth });
  const out = new Map<string, VideoStatus>();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const res = await youtube.videos.list({ part: ["status", "statistics"], id: batch });
    for (const item of res.data.items ?? []) {
      if (item.id && item.status?.privacyStatus) {
        out.set(item.id, {
          privacyStatus: item.status.privacyStatus as PrivacyStatus,
          viewCount: item.statistics?.viewCount !== undefined ? Number(item.statistics.viewCount) : undefined,
          likeCount: item.statistics?.likeCount !== undefined ? Number(item.statistics.likeCount) : undefined,
          commentCount: item.statistics?.commentCount !== undefined ? Number(item.statistics.commentCount) : undefined,
        });
      }
    }
  }
  return out;
}
