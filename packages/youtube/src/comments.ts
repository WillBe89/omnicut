/**
 * Reading and replying to comments on your own videos. Note: YouTube's public
 * API has no endpoint to PIN a comment — that's Studio-UI-only — so this only
 * covers listing, posting a new top-level comment, and replying.
 */
import { google } from "googleapis";
import type { OAuth2Client } from "./auth.js";

export interface CommentSummary {
  id: string;
  authorDisplayName: string;
  textDisplay: string;
  likeCount: number;
  publishedAt: string;
  totalReplyCount: number;
}

export class CommentsScopeError extends Error {
  constructor() {
    super(
      "This account's token predates the comments scope. Re-authorize it " +
      "(Accounts → ⟲ in the Publish panel, or `account-reauth <id>` on the CLI) to enable comment reading/replying.",
    );
    this.name = "CommentsScopeError";
  }
}

interface ApiErrorShape { code?: number; message?: string; errors?: { reason?: string; message?: string }[] }

function isCommentsDisabled(err: unknown): boolean {
  const e = err as ApiErrorShape;
  return e?.code === 403 && e.errors?.[0]?.reason === "commentsDisabled";
}

function rethrowCommentsError(err: unknown): never {
  const e = err as ApiErrorShape;
  if (e?.code === 403 && /insufficient/i.test(e.errors?.[0]?.message ?? e.message ?? "")) throw new CommentsScopeError();
  throw err;
}

/** The video's top-level comments, YouTube's own "relevance" ranking (same
 *  order Studio shows by default). Returns [] (not an error) for videos that
 *  simply have comments turned off. */
export async function listTopComments(auth: OAuth2Client, videoId: string, maxResults = 20): Promise<CommentSummary[]> {
  const youtube = google.youtube({ version: "v3", auth });
  try {
    const res = await youtube.commentThreads.list({
      part: ["snippet"],
      videoId,
      maxResults,
      order: "relevance",
      textFormat: "plainText",
    });
    return (res.data.items ?? []).map((thread) => {
      const top = thread.snippet?.topLevelComment?.snippet;
      return {
        id: thread.snippet?.topLevelComment?.id ?? thread.id ?? "",
        authorDisplayName: top?.authorDisplayName ?? "Unknown",
        textDisplay: top?.textDisplay ?? "",
        likeCount: top?.likeCount ?? 0,
        publishedAt: top?.publishedAt ?? "",
        totalReplyCount: thread.snippet?.totalReplyCount ?? 0,
      };
    });
  } catch (err) {
    if (isCommentsDisabled(err)) return [];
    rethrowCommentsError(err);
  }
}

/** Post a brand-new top-level comment on your own video — e.g. links/CTA
 *  posted automatically right after upload. Returns the new comment's id. */
export async function postComment(auth: OAuth2Client, videoId: string, text: string): Promise<string> {
  const youtube = google.youtube({ version: "v3", auth });
  try {
    const res = await youtube.commentThreads.insert({
      part: ["snippet"],
      requestBody: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } },
    });
    return res.data.id ?? "";
  } catch (err) {
    rethrowCommentsError(err);
  }
}

/** Reply to an existing top-level comment (thread root or another reply's
 *  parent id). Returns the new reply's id. */
export async function replyToComment(auth: OAuth2Client, parentId: string, text: string): Promise<string> {
  const youtube = google.youtube({ version: "v3", auth });
  try {
    const res = await youtube.comments.insert({
      part: ["snippet"],
      requestBody: { snippet: { parentId, textOriginal: text } },
    });
    return res.data.id ?? "";
  } catch (err) {
    rethrowCommentsError(err);
  }
}
