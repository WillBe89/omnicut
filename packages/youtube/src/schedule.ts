import { google } from "googleapis";
import type { OAuth2Client } from "./auth.js";

/** Change an ALREADY-UPLOADED video's scheduled release time. Unlike the
 *  local queue.json's publishAt (which only takes effect at upload time),
 *  this reaches into YouTube and corrects the real, already-set schedule —
 *  necessary because editing our local record alone does nothing once a
 *  video is live on their servers. */
export async function updateVideoSchedule(auth: OAuth2Client, videoId: string, publishAt: string): Promise<void> {
  const youtube = google.youtube({ version: "v3", auth });
  await youtube.videos.update({
    part: ["status"],
    requestBody: {
      id: videoId,
      status: { privacyStatus: "private", publishAt },
    },
  });
}
