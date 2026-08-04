import { createReadStream } from "node:fs";
import { google } from "googleapis";
import type { OAuth2Client } from "./auth.js";
import type { QueueEntry, PrivacyStatus } from "./queue.js";

export class QuotaExceededError extends Error {
  constructor(cause: string) {
    super(`YouTube API daily quota exceeded: ${cause}`);
    this.name = "QuotaExceededError";
  }
}

function isQuotaError(err: unknown): boolean {
  const e = err as { code?: number; errors?: { reason?: string }[]; message?: string };
  if (e?.code !== 403) return false;
  const reason = e.errors?.[0]?.reason ?? "";
  return reason === "quotaExceeded" || reason === "dailyLimitExceeded" || /quota/i.test(e.message ?? "");
}

export interface UploadResult {
  videoId: string;
  thumbnailSet: boolean;
}

/** Set a video's custom thumbnail. Requires the channel to be phone-verified
 *  at youtube.com/verify — without that, YouTube rejects thumbnails.set for
 *  every channel regardless of OAuth scope, with a permissions error. */
export async function setThumbnail(auth: OAuth2Client, videoId: string, thumbnailPath: string): Promise<void> {
  const youtube = google.youtube({ version: "v3", auth });
  try {
    await youtube.thumbnails.set({ videoId, media: { body: createReadStream(thumbnailPath) } });
  } catch (err) {
    if (isQuotaError(err)) throw new QuotaExceededError((err as Error).message);
    throw err;
  }
}

/** Upload one queued video (resumable upload handled internally by googleapis)
 *  and, if provided, set its custom thumbnail. Throws QuotaExceededError when
 *  the daily API quota is spent — callers should stop the run, not retry. */
export async function uploadVideo(auth: OAuth2Client, entry: QueueEntry): Promise<UploadResult> {
  const youtube = google.youtube({ version: "v3", auth });

  let videoId: string;
  try {
    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      notifySubscribers: entry.notifySubscribers ?? true,
      requestBody: {
        snippet: {
          title: entry.title,
          description: entry.description,
          tags: entry.tags,
          categoryId: entry.categoryId,
        },
        status: {
          privacyStatus: entry.privacyStatus,
          ...(entry.privacyStatus === "private" && entry.publishAt ? { publishAt: entry.publishAt } : {}),
          selfDeclaredMadeForKids: entry.madeForKids ?? false,
          license: entry.license ?? "youtube",
          embeddable: entry.embeddable ?? true,
          publicStatsViewable: entry.publicStatsViewable ?? true,
        },
      },
      media: { body: createReadStream(entry.videoPath) },
    });
    videoId = res.data.id!;
  } catch (err) {
    if (isQuotaError(err)) throw new QuotaExceededError((err as Error).message);
    throw err;
  }

  let thumbnailSet = false;
  if (entry.thumbnailPath) {
    try {
      await setThumbnail(auth, videoId, entry.thumbnailPath);
      thumbnailSet = true;
    } catch (err) {
      if (err instanceof QuotaExceededError) throw err;
      // Thumbnail failures shouldn't fail the whole upload — the video is live either way.
      console.error(`  (warning) thumbnail upload failed for ${entry.id}: ${(err as Error).message}`);
    }
  }

  return { videoId, thumbnailSet };
}

export interface LiveVideoPatch {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: PrivacyStatus;
  /** Only meaningful while privacyStatus is/stays "private" — reschedules when YouTube auto-flips it public. */
  publishAt?: string;
  madeForKids?: boolean;
  license?: "youtube" | "creativeCommon";
  embeddable?: boolean;
  publicStatsViewable?: boolean;
}

/** Edit an ALREADY-UPLOADED video's metadata. YouTube's videos.update isn't a
 *  true partial patch — the API replaces the whole snippet/status object for
 *  any part you send — so this fetches the current values first and merges
 *  the patch on top, only touching the parts that actually changed. */
export async function updateLiveVideo(auth: OAuth2Client, videoId: string, patch: LiveVideoPatch): Promise<void> {
  const youtube = google.youtube({ version: "v3", auth });
  const needsSnippet = patch.title !== undefined || patch.description !== undefined || patch.tags !== undefined || patch.categoryId !== undefined;
  const needsStatus =
    patch.privacyStatus !== undefined || patch.publishAt !== undefined || patch.madeForKids !== undefined ||
    patch.license !== undefined || patch.embeddable !== undefined || patch.publicStatsViewable !== undefined;
  if (!needsSnippet && !needsStatus) return;

  const parts = [...(needsSnippet ? ["snippet"] : []), ...(needsStatus ? ["status"] : [])];
  try {
    const current = await youtube.videos.list({ part: parts, id: [videoId] });
    const existing = current.data.items?.[0];
    if (!existing) throw new Error(`Video ${videoId} not found (was it deleted on YouTube?).`);

    const requestBody: { id: string; snippet?: object; status?: object } = { id: videoId };
    if (needsSnippet) {
      requestBody.snippet = {
        ...existing.snippet,
        title: patch.title ?? existing.snippet?.title,
        description: patch.description ?? existing.snippet?.description,
        tags: patch.tags ?? existing.snippet?.tags,
        categoryId: patch.categoryId ?? existing.snippet?.categoryId,
      };
    }
    if (needsStatus) {
      requestBody.status = {
        ...existing.status,
        privacyStatus: patch.privacyStatus ?? existing.status?.privacyStatus,
        publishAt: patch.publishAt ?? existing.status?.publishAt,
        selfDeclaredMadeForKids: patch.madeForKids ?? existing.status?.selfDeclaredMadeForKids,
        license: patch.license ?? existing.status?.license,
        embeddable: patch.embeddable ?? existing.status?.embeddable,
        publicStatsViewable: patch.publicStatsViewable ?? existing.status?.publicStatsViewable,
      };
    }
    await youtube.videos.update({ part: parts, requestBody });
  } catch (err) {
    if (isQuotaError(err)) throw new QuotaExceededError((err as Error).message);
    throw err;
  }
}
