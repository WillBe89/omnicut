import { createReadStream } from "node:fs";
import { google } from "googleapis";
import type { OAuth2Client } from "./auth.js";
import type { QueueEntry } from "./queue.js";

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
          selfDeclaredMadeForKids: false,
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
