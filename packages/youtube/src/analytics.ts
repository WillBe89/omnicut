/**
 * YouTube Analytics API (youtubeAnalytics/v2) — a separate API and OAuth
 * scope from the Data API used everywhere else in this package. Surfaces the
 * numbers YouTube normally keeps inside Studio: watch time, retention,
 * traffic sources, subscriber deltas.
 */
import { google } from "googleapis";
import type { OAuth2Client } from "./auth.js";

export class AnalyticsScopeError extends Error {
  constructor() {
    super(
      "This account hasn't granted YouTube Analytics access yet. Re-authorize it " +
      "(Accounts → ⟲ in the Publish panel, or `account-reauth <id>` on the CLI) to enable analytics.",
    );
    this.name = "AnalyticsScopeError";
  }
}

export class AnalyticsApiDisabledError extends Error {
  constructor(activationUrl?: string) {
    super(
      "The YouTube Analytics API isn't enabled for this project yet — it's a separate toggle from " +
      "YouTube Data API v3. Enable it in Google Cloud Console" +
      (activationUrl ? `: ${activationUrl}` : " (APIs & Services → Library → search \"YouTube Analytics API\" → Enable") +
      ", then wait a minute or two for it to propagate.",
    );
    this.name = "AnalyticsApiDisabledError";
  }
}

interface ApiErrorShape {
  code?: number;
  message?: string;
  errors?: { reason?: string; message?: string }[];
  errors_?: never;
}

function asApiError(err: unknown): ApiErrorShape {
  return err as ApiErrorShape;
}

/** Throws the right actionable error for a 403 from the Analytics API —
 *  either "API not enabled for this Cloud project" (a one-time Console
 *  toggle, the far more common first-run blocker) or "this account's token
 *  predates the Analytics scope" (needs re-consent). Anything else rethrows
 *  as-is so real errors (network, quota, etc.) aren't swallowed. */
function rethrowAnalyticsError(err: unknown): never {
  const e = asApiError(err);
  if (e?.code === 403) {
    const reason = e.errors?.[0]?.reason ?? "";
    const message = e.errors?.[0]?.message ?? e.message ?? "";
    if (reason === "accessNotConfigured" || /has not been used|is disabled/i.test(message)) {
      const urlMatch = /https:\/\/console\.developers\.google\.com\S*/.exec(message);
      throw new AnalyticsApiDisabledError(urlMatch?.[0]);
    }
    if (/insufficient|forbidden/i.test(message)) throw new AnalyticsScopeError();
  }
  throw err;
}

function dateRange(sinceDays: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - sinceDays * 24 * 3600 * 1000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export interface VideoAnalytics {
  views: number;
  estimatedMinutesWatched: number;
  /** Seconds. */
  averageViewDuration: number;
  /** 0-100. */
  averageViewPercentage: number;
  subscribersGained: number;
  subscribersLost: number;
}

const VIDEO_METRICS = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost";

/** Lifetime-to-date (or `sinceDays`-window) performance for one video. Returns
 *  null if YouTube has no rows yet (e.g. a just-published video). */
export async function fetchVideoAnalytics(auth: OAuth2Client, videoId: string, sinceDays = 365): Promise<VideoAnalytics | null> {
  const yta = google.youtubeAnalytics({ version: "v2", auth });
  const { startDate, endDate } = dateRange(sinceDays);
  try {
    const res = await yta.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: VIDEO_METRICS,
      filters: `video==${videoId}`,
    });
    const row = res.data.rows?.[0];
    if (!row) return null;
    const n = (i: number) => Number(row[i] ?? 0);
    return {
      views: n(0), estimatedMinutesWatched: n(1), averageViewDuration: n(2),
      averageViewPercentage: n(3), subscribersGained: n(4), subscribersLost: n(5),
    };
  } catch (err) {
    rethrowAnalyticsError(err);
  }
}

/** Same metrics as fetchVideoAnalytics but WHOLE-CHANNEL (no video filter) —
 *  for comparing channels against each other, not one video. Default 28-day
 *  window matches YouTube Studio's own default comparison period. */
export async function fetchChannelAnalytics(auth: OAuth2Client, sinceDays = 28): Promise<VideoAnalytics | null> {
  const yta = google.youtubeAnalytics({ version: "v2", auth });
  const { startDate, endDate } = dateRange(sinceDays);
  try {
    const res = await yta.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: VIDEO_METRICS,
    });
    const row = res.data.rows?.[0];
    if (!row) return null;
    const n = (i: number) => Number(row[i] ?? 0);
    return {
      views: n(0), estimatedMinutesWatched: n(1), averageViewDuration: n(2),
      averageViewPercentage: n(3), subscribersGained: n(4), subscribersLost: n(5),
    };
  } catch (err) {
    rethrowAnalyticsError(err);
  }
}

export interface TrafficSource {
  source: string;
  views: number;
}

/** Where this video's views actually came from (search, suggested, browse,
 *  external, etc.), ranked highest-first. */
export async function fetchTrafficSources(auth: OAuth2Client, videoId: string, sinceDays = 365): Promise<TrafficSource[]> {
  const yta = google.youtubeAnalytics({ version: "v2", auth });
  const { startDate, endDate } = dateRange(sinceDays);
  try {
    const res = await yta.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: "views",
      dimensions: "insightTrafficSourceType",
      filters: `video==${videoId}`,
      sort: "-views",
    });
    return (res.data.rows ?? []).map((r) => ({ source: humanizeTrafficSource(String(r[0])), views: Number(r[1]) }));
  } catch (err) {
    rethrowAnalyticsError(err);
  }
}

/** YouTube's raw traffic-source codes aren't self-explanatory — map the common ones. */
function humanizeTrafficSource(code: string): string {
  const names: Record<string, string> = {
    ADVERTISING: "Advertising",
    ANNOTATION: "Annotations",
    CAMPAIGN_CARD: "Campaign card",
    END_SCREEN: "End screens",
    EXT_URL: "External sites/apps",
    NOTIFICATION: "Notifications",
    PLAYLIST: "Playlist",
    PROMOTED: "Promoted content",
    RELATED_VIDEO: "Suggested videos",
    SUBSCRIBER: "Subscription feed",
    YT_CHANNEL: "Channel page",
    YT_OTHER_PAGE: "Other YouTube pages",
    YT_SEARCH: "YouTube search",
    NO_LINK_OTHER: "Direct or unknown",
    SHORTS: "Shorts feed",
  };
  return names[code] ?? code;
}

export interface ChannelDayTotals {
  date: string;
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
}

/** Day-by-day channel totals — used to work out which weekday/time this
 *  channel's audience is actually most active, for "best time to post". */
export async function fetchChannelDailyTotals(auth: OAuth2Client, sinceDays = 90): Promise<ChannelDayTotals[]> {
  const yta = google.youtubeAnalytics({ version: "v2", auth });
  const { startDate, endDate } = dateRange(sinceDays);
  try {
    const res = await yta.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: "views,estimatedMinutesWatched,subscribersGained",
      dimensions: "day",
      sort: "day",
    });
    return (res.data.rows ?? []).map((r) => ({
      date: String(r[0]),
      views: Number(r[1]),
      estimatedMinutesWatched: Number(r[2]),
      subscribersGained: Number(r[3]),
    }));
  } catch (err) {
    rethrowAnalyticsError(err);
  }
}
