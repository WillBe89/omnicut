/**
 * Channel-level health trends — "views/subscribers gained this week vs last
 * week." Uses channels.list's own running totals (subscriberCount, viewCount,
 * videoCount) rather than trying to sum our own tracked videos, since a
 * channel usually has more videos than just the ones OmniCut's queue knows
 * about. A day's snapshot is cheap (1 quota unit) and piggybacks on whatever
 * already re-authorizes/refreshes an account, so history accumulates
 * naturally without a dedicated "record a snapshot" action.
 */
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIALS_DIR } from "./credentials.js";
import type { OAuth2Client } from "./auth.js";

const HISTORY_DIR = join(CREDENTIALS_DIR, "accounts");

function historyPath(accountId: string): string {
  return join(HISTORY_DIR, accountId, "channel-history.json");
}

export interface ChannelSnapshot {
  /** YYYY-MM-DD, local calendar day. */
  date: string;
  subscriberCount: number;
  viewCount: number;
  videoCount: number;
}

function loadHistory(accountId: string): ChannelSnapshot[] {
  const path = historyPath(accountId);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ChannelSnapshot[];
  } catch {
    return [];
  }
}

function saveHistory(accountId: string, history: ChannelSnapshot[]): void {
  const path = historyPath(accountId);
  mkdirSync(join(HISTORY_DIR, accountId), { recursive: true });
  writeFileSync(path, JSON.stringify(history, null, 2), "utf8");
}

/** Fetch today's channel totals and record them — replaces today's entry if
 *  one already exists (so calling this multiple times a day doesn't pile up
 *  duplicate rows), keeps at most a year of daily history. */
export async function recordChannelSnapshot(accountId: string, auth: OAuth2Client): Promise<ChannelSnapshot> {
  const youtube = google.youtube({ version: "v3", auth });
  const res = await youtube.channels.list({ part: ["statistics"], mine: true });
  const stats = res.data.items?.[0]?.statistics;
  const snapshot: ChannelSnapshot = {
    date: new Date().toISOString().slice(0, 10),
    subscriberCount: Number(stats?.subscriberCount ?? 0),
    viewCount: Number(stats?.viewCount ?? 0),
    videoCount: Number(stats?.videoCount ?? 0),
  };
  const history = loadHistory(accountId).filter((s) => s.date !== snapshot.date);
  history.push(snapshot);
  history.sort((a, b) => a.date.localeCompare(b.date));
  saveHistory(accountId, history.slice(-365));
  return snapshot;
}

export interface ChannelTrend {
  history: ChannelSnapshot[];
  latest: ChannelSnapshot | null;
  /** Gained in the last 7 recorded days vs. the 7 before that — null if there's not enough history yet. */
  last7Days: { views: number; subscribers: number } | null;
  prev7Days: { views: number; subscribers: number } | null;
}

/** Reads whatever local history exists — no API call, so this is safe/cheap
 *  to call on every dashboard render. */
export function getChannelTrend(accountId: string): ChannelTrend {
  const history = loadHistory(accountId);
  const latest = history[history.length - 1] ?? null;
  const at = (fromEnd: number): ChannelSnapshot | undefined => history[history.length - 1 - fromEnd];

  const delta = (a?: ChannelSnapshot, b?: ChannelSnapshot) =>
    a && b ? { views: a.viewCount - b.viewCount, subscribers: a.subscriberCount - b.subscriberCount } : null;

  return {
    history,
    latest,
    last7Days: delta(at(0), at(7)),
    prev7Days: delta(at(7), at(14)),
  };
}
