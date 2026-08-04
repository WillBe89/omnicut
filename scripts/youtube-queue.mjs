#!/usr/bin/env node
/**
 * YouTube upload queue CLI — a thin wrapper over @video-editor/youtube's
 * manager functions (the OmniCut desktop app's Publish panel calls the exact
 * same functions, so behavior never drifts between the CLI and the GUI).
 *
 *   node scripts/youtube-queue.mjs init --client-secret <path>
 *   node scripts/youtube-queue.mjs add <folder> [--every-days 3] [--start "2026-08-01 17:00"] [--tags a,b,c] [--title-prefix "Your Name"] [--description "..."]
 *   node scripts/youtube-queue.mjs list <folder>
 *   node scripts/youtube-queue.mjs run <folder> [--limit N] [--dry]
 *   node scripts/youtube-queue.mjs thumbnails <folder>
 *   node scripts/youtube-queue.mjs playlist-set <folder> --title "..." [--description "..."] [--privacy public]
 *   node scripts/youtube-queue.mjs sync-playlist <folder> [--dry]
 *   node scripts/youtube-queue.mjs run-all <folder>          # run + sync-playlist in one go
 *   node scripts/youtube-queue.mjs reschedule <folder> --start "..." [--every-days 3]
 *   node scripts/youtube-queue.mjs folders                   # list folders registered for the GUI
 *   node scripts/youtube-queue.mjs schedule                  # every folder's releases, one chronological list
 *   node scripts/youtube-queue.mjs refresh-live <folder>     # pull real status + views/likes/comments from YouTube
 *   node scripts/youtube-queue.mjs upload-settings-set <folder> [--category 10] [--made-for-kids] [--license creativeCommon] [--no-embed] [--no-public-stats] [--no-notify]
 *
 * The queue file lives at <folder>/.youtube-queue.json — safe to re-run any
 * command; each only acts on what's actually new/pending/missing.
 *
 * One-time setup (see README): create a Google Cloud project, enable the
 * YouTube Data API v3, create an OAuth Client ID of type "Desktop app", and
 * download its JSON — that's the --client-secret path for `init`.
 */
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  authorize, hasStoredCredentials, CLIENT_SECRET_PATH, TOKEN_PATH, CREDENTIALS_DIR,
  getQueueSnapshot, addFolderToQueue, runQueueUploads, retryQueueThumbnails,
  setQueuePlaylist, setQueueAccount, previewPlaylistSync, syncQueuePlaylist, rescheduleQueue,
  registerFolder, listKnownFoldersWithSummary,
  listAccounts, addAccount, removeAccount, completeAccountAuth, reauthorizeAccount, DEFAULT_ACCOUNT_ID,
  runAllFolders, getUnifiedSchedule, refreshLiveStatus, setUploadDefaults, getVideoAnalytics, getChannelTrend,
  getEntryComments, postEntryComment, replyToEntryComment,
  checkSeo, suggestKeywords, bulkUpdateEntries, getAllChannelDashboards,
} from "@video-editor/youtube";

const [, , cmd, ...rest] = process.argv;
const flags = new Map();
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    // Only consume the next token as this flag's value if it isn't itself a
    // flag — otherwise a boolean flag (e.g. --dry, --made-for-kids) directly
    // followed by another flag would silently swallow it as a bogus value.
    if (next !== undefined && !next.startsWith("--")) { flags.set(key, next); i++; }
    else flags.set(key, "true");
  } else positional.push(rest[i]);
}

function usageAndExit() {
  console.error(
    "Usage:\n" +
    "  node scripts/youtube-queue.mjs init --client-secret <path>\n" +
    "  node scripts/youtube-queue.mjs add <folder> [--every-days 3] [--start \"YYYY-MM-DD HH:mm\"] [--tags a,b,c] [--title-prefix \"Your Name\"] [--description \"...\"]\n" +
    "  node scripts/youtube-queue.mjs list <folder>\n" +
    "  node scripts/youtube-queue.mjs run <folder> [--limit N] [--dry]\n" +
    "  node scripts/youtube-queue.mjs thumbnails <folder>\n" +
    "  node scripts/youtube-queue.mjs playlist-set <folder> --title \"...\" [--description \"...\"] [--privacy public]\n" +
    "  node scripts/youtube-queue.mjs sync-playlist <folder> [--dry]\n" +
    "  node scripts/youtube-queue.mjs run-all <folder>\n" +
    "  node scripts/youtube-queue.mjs run-everything   # every registered folder, concurrently\n" +
    "  node scripts/youtube-queue.mjs reschedule <folder> --start \"...\" [--every-days 3]\n" +
    "  node scripts/youtube-queue.mjs folders\n" +
    "  node scripts/youtube-queue.mjs schedule                 # every folder's releases, one chronological list\n" +
    "  node scripts/youtube-queue.mjs refresh-live <folder>     # pull real status + views/likes/comments from YouTube\n" +
    "  node scripts/youtube-queue.mjs upload-settings-set <folder> [--category 10] [--made-for-kids|--not-made-for-kids] [--license youtube|creativeCommon] [--no-embed] [--no-public-stats] [--no-notify] [--description-template \"{title}\\n\\nlinks...\"] [--auto-comment \"...\"]\n" +
    "  node scripts/youtube-queue.mjs account-add <id> --label \"...\" [--client-secret <path>]\n" +
    "  node scripts/youtube-queue.mjs account-list\n" +
    "  node scripts/youtube-queue.mjs account-remove <id>\n" +
    "  node scripts/youtube-queue.mjs account-set <folder> --account <id>\n" +
    "  node scripts/youtube-queue.mjs account-reauth [id]     # re-grant permissions (needed once for Analytics on older accounts)\n" +
    "  node scripts/youtube-queue.mjs analytics <folder> <video-id>   # watch time, retention, traffic sources",
  );
  process.exit(1);
}

async function cmdInit() {
  const src = flags.get("client-secret");
  if (!src) usageAndExit();
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  copyFileSync(resolve(src), CLIENT_SECRET_PATH);
  const auth = await authorize(CLIENT_SECRET_PATH, TOKEN_PATH);
  const { google } = await import("googleapis");
  const youtube = google.youtube({ version: "v3", auth });
  const res = await youtube.channels.list({ part: ["snippet"], mine: true });
  const channel = res.data.items?.[0]?.snippet?.title ?? "(unknown channel)";
  console.log(`\n✅ Authorized. Uploading will publish to channel: "${channel}"`);
  console.log(`Credentials saved to ${CREDENTIALS_DIR}`);
}

function requireAuth() {
  if (!hasStoredCredentials()) {
    console.error(`No credentials found. Run: node scripts/youtube-queue.mjs init --client-secret <path>`);
    process.exit(1);
  }
}

async function cmdAdd() {
  const folder = resolve(positional[0] ?? ".");
  registerFolder(folder, positional[0] ?? folder);
  const added = await addFolderToQueue(folder, {
    everyDays: Number(flags.get("every-days") ?? 3),
    startDate: flags.get("start"),
    extraTags: (flags.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    titlePrefix: flags.get("title-prefix"),
    description: flags.get("description"),
  });
  if (added.length === 0) { console.log("Nothing new to add — every video in this folder is already queued."); return; }
  console.log(`Added ${added.length} video(s):\n`);
  for (const a of added) console.log(`  [${a.id}]  publishes ${new Date(a.publishAt).toLocaleString()}`);
}

function cmdList() {
  const folder = resolve(positional[0] ?? ".");
  const queue = getQueueSnapshot(folder);
  if (queue.entries.length === 0) { console.log("Queue is empty."); return; }
  for (const e of queue.entries) {
    const when = e.publishAt ? new Date(e.publishAt).toLocaleString() : "—";
    const status = e.status === "uploaded" ? `✅ uploaded (${e.youtubeVideoId})${e.addedToPlaylist ? " [in playlist]" : ""}`
      : e.status === "error" ? `❌ ${e.error}`
      : "⏳ pending";
    console.log(`[${e.id}]  publish: ${when}  ${status}`);
  }
  if (queue.playlist) console.log(`\nPlaylist: "${queue.playlist.title}" (${queue.playlist.privacyStatus})${queue.playlist.playlistId ? ` — https://www.youtube.com/playlist?list=${queue.playlist.playlistId}` : " — not yet created"}`);
}

async function cmdRun() {
  const folder = resolve(positional[0] ?? ".");
  const limit = flags.has("limit") ? Number(flags.get("limit")) : undefined;
  const dry = flags.has("dry");
  const pending = getQueueSnapshot(folder).entries.filter((e) => e.status === "pending").slice(0, limit ?? Infinity);
  if (pending.length === 0) { console.log("Nothing pending."); return; }
  if (dry) {
    console.log(`Would upload ${pending.length} video(s):`);
    for (const e of pending) console.log(`  [${e.id}] "${e.title}" — publish ${e.publishAt}`);
    return;
  }
  requireAuth();
  const result = await runQueueUploads(folder, {
    limit,
    onProgress: (e) => {
      if (e.kind === "uploading") process.stdout.write(`⬆️  ${e.id} … `);
      else if (e.kind === "done") console.log(`done (https://youtu.be/${e.videoId})`);
      else if (e.kind === "error") console.log(`FAILED: ${e.error}`);
      else if (e.kind === "quota") console.log(`\n\nDaily upload quota reached. Uploaded ${e.uploaded}/${e.total} this run — the rest stay queued, re-run tomorrow.`);
    },
  });
  if (!result.quotaHit) console.log(`\nDone: ${result.uploaded}/${result.total} uploaded.`);
}

async function cmdThumbnails() {
  const folder = resolve(positional[0] ?? ".");
  requireAuth();
  const result = await retryQueueThumbnails(folder, (e) => {
    console.log(e.ok ? `🖼️  ${e.id} … done` : `🖼️  ${e.id} … still failing: ${e.error}`);
  });
  if (result.total === 0) console.log("Nothing to retry — every uploaded video already has its thumbnail set.");
  else if (result.quotaHit) console.log("\nDaily quota reached — re-run this command again later.");
  else console.log(`\n${result.fixed}/${result.total} thumbnails set.`);
}

function cmdPlaylistSet() {
  const folder = resolve(positional[0] ?? ".");
  const title = flags.get("title");
  if (!title) { console.error('--title is required, e.g. --title "UNBREAKABLE"'); process.exit(1); }
  setQueuePlaylist(folder, { title, description: flags.get("description"), privacyStatus: flags.get("privacy") ?? "public" });
  console.log(`Playlist config saved: "${title}".`);
}

async function cmdSyncPlaylist() {
  const folder = resolve(positional[0] ?? ".");
  const dry = flags.has("dry");
  requireAuth();
  if (dry) {
    const plan = await previewPlaylistSync(folder);
    console.log(`Playlist: ${plan.playlistId ?? "not yet created"}`);
    console.log(`Would add ${plan.toAdd.length}: ${plan.toAdd.map((e) => e.id).join(", ") || "(none)"}`);
    console.log(`Not live yet (correctly skipped): ${plan.notLiveYet.map((e) => e.id).join(", ") || "(none)"}`);
    return;
  }
  const result = await syncQueuePlaylist(folder, (m) => console.log(m));
  if (result.quotaHit) console.log("Daily quota reached — re-run this command again later.");
  else console.log(`\nPlaylist https://www.youtube.com/playlist?list=${result.playlistId} — added ${result.added.length} video(s).`);
}

async function cmdRunAll() {
  await cmdRun();
  const folder = resolve(positional[0] ?? ".");
  if (getQueueSnapshot(folder).playlist) {
    console.log("\n— syncing playlist —");
    await cmdSyncPlaylist();
  }
}

function cmdReschedule() {
  const folder = resolve(positional[0] ?? ".");
  const start = flags.get("start");
  if (!start) { console.error('--start is required, e.g. --start "2026-08-01 17:00"'); process.exit(1); }
  const touched = rescheduleQueue(folder, start, Number(flags.get("every-days") ?? 3));
  console.log(`Rescheduled ${touched.length} pending video(s):`);
  for (const e of touched) console.log(`  [${e.id}]  ${new Date(e.publishAt).toLocaleString()}`);
}

function cmdFolders() {
  const folders = listKnownFoldersWithSummary();
  if (folders.length === 0) { console.log("No folders registered yet — run `add` on one to register it."); return; }
  for (const f of folders) {
    console.log(`${f.label} (${f.path})`);
    console.log(`  ${f.uploaded} uploaded, ${f.pending} pending, ${f.errored} errors${f.playlist ? ` — playlist "${f.playlist.title}"` : ""}`);
  }
}

async function cmdAccountAdd() {
  const id = positional[0];
  if (!id) { console.error("account id is required, e.g. account-add kids-books"); process.exit(1); }
  const label = flags.get("label") ?? id;
  const clientSecret = flags.get("client-secret");
  addAccount(id, label, clientSecret ? resolve(clientSecret) : undefined);
  console.log(`Account "${id}" registered. Authorizing…`);
  const channel = await completeAccountAuth(id);
  console.log(`✅ "${id}" → channel "${channel}"`);
}

function cmdAccountList() {
  const accounts = listAccounts();
  if (accounts.length === 0) { console.log("No accounts yet."); return; }
  for (const a of accounts) {
    console.log(`[${a.id}] ${a.label}${a.channelTitle ? ` — channel "${a.channelTitle}"` : " (not yet authorized)"}`);
  }
}

function cmdAccountRemove() {
  const id = positional[0];
  if (!id) { console.error("account id is required"); process.exit(1); }
  if (id === DEFAULT_ACCOUNT_ID) { console.error("Can't remove the default account."); process.exit(1); }
  removeAccount(id);
  console.log(`Account "${id}" removed (its folders will fall back to the default account).`);
}

async function cmdAccountReauth() {
  const id = positional[0] ?? DEFAULT_ACCOUNT_ID;
  console.log(`Re-authorizing "${id}"… check your browser.`);
  const channel = await reauthorizeAccount(id);
  console.log(`✅ "${id}" re-authorized — channel "${channel}". Newly-added scopes (e.g. Analytics) are now granted.`);
}

async function cmdAnalytics() {
  const folder = resolve(positional[0] ?? ".");
  const entryId = positional[1];
  if (!entryId) { console.error('video id is required, e.g. analytics "<folder>" "Bad Habit"'); process.exit(1); }
  const { analytics, trafficSources } = await getVideoAnalytics(folder, entryId);
  if (!analytics) { console.log("No analytics data yet — check back once it's had some views."); return; }
  const mins = Math.floor(analytics.averageViewDuration / 60);
  const secs = Math.round(analytics.averageViewDuration % 60);
  console.log(`Views: ${analytics.views}`);
  console.log(`Estimated minutes watched: ${Math.round(analytics.estimatedMinutesWatched)}`);
  console.log(`Average view duration: ${mins}:${String(secs).padStart(2, "0")}`);
  console.log(`Average % viewed: ${analytics.averageViewPercentage.toFixed(1)}%`);
  console.log(`Subscribers: +${analytics.subscribersGained} / -${analytics.subscribersLost}`);
  if (trafficSources.length > 0) {
    console.log(`\nTop traffic sources:`);
    for (const t of trafficSources.slice(0, 8)) console.log(`  ${t.source}: ${t.views}`);
  }
}

async function cmdRunEverything() {
  const folders = listKnownFoldersWithSummary().map((f) => f.path);
  if (folders.length === 0) { console.log("No folders registered."); return; }
  console.log(`Running ${folders.length} folder(s) concurrently (same-account folders queue, different accounts run in parallel)…\n`);
  const results = await runAllFolders(folders, (folder, e) => {
    if (e.kind === "uploading") console.log(`⬆️  [${folder}] ${e.id} …`);
    else if (e.kind === "done") console.log(`✅ [${folder}] ${e.id} → https://youtu.be/${e.videoId}`);
    else if (e.kind === "error") console.log(`❌ [${folder}] ${e.id}: ${e.error}`);
    else if (e.kind === "quota") console.log(`⏸️  [${folder}] quota reached (${e.uploaded}/${e.total})`);
  });
  console.log("\nSummary:");
  for (const r of results) {
    if (r.error) { console.log(`  ${r.folder}: ERROR ${r.error}`); continue; }
    console.log(`  ${r.folder}: uploaded ${r.upload.uploaded}/${r.upload.total}${r.sync ? `, playlist +${r.sync.added.length}` : ""}`);
  }
}

function cmdUploadSettingsSet() {
  const folder = resolve(positional[0] ?? ".");
  const defaults = {};
  if (flags.has("category")) defaults.categoryId = flags.get("category");
  if (flags.has("made-for-kids")) defaults.madeForKids = true;
  if (flags.has("not-made-for-kids")) defaults.madeForKids = false;
  if (flags.has("license")) defaults.license = flags.get("license");
  if (flags.has("no-embed")) defaults.embeddable = false;
  if (flags.has("no-public-stats")) defaults.publicStatsViewable = false;
  if (flags.has("no-notify")) defaults.notifySubscribers = false;
  if (flags.has("description-template")) defaults.descriptionTemplate = flags.get("description-template");
  if (flags.has("auto-comment")) defaults.autoCommentTemplate = flags.get("auto-comment");
  setUploadDefaults(folder, defaults);
  console.log(`Upload defaults updated for new videos added to ${folder}:`, defaults);
}

function cmdSchedule() {
  const items = getUnifiedSchedule();
  if (items.length === 0) { console.log("Nothing queued anywhere yet."); return; }
  let lastDay = "";
  for (const { folderLabel, entry } of items) {
    const day = entry.publishAt ? new Date(entry.publishAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "No date set";
    if (day !== lastDay) { console.log(`\n${day}`); lastDay = day; }
    const status =
      entry.status === "error" ? `❌ ${entry.error}`
      : entry.status === "pending" ? "⏳ pending upload"
      : entry.livePrivacyStatus === "public" ? `🌐 live${entry.addedToPlaylist ? " · in playlist" : ""}`
      : `🔒 scheduled${entry.livePrivacyStatus ? "" : " (live status unchecked — run refresh-live)"}`;
    console.log(`  [${folderLabel}] ${entry.title} — ${status}`);
  }
}

async function cmdRefreshLive() {
  const folder = resolve(positional[0] ?? ".");
  requireAuth();
  const touched = await refreshLiveStatus(folder);
  if (touched.length === 0) { console.log("Nothing to check (no uploaded videos yet)."); return; }
  for (const e of touched) console.log(`  ${e.title} — ${e.livePrivacyStatus}`);
  console.log(`\nChecked ${touched.length} video(s).`);
}

function cmdChannelHealth() {
  const accountId = positional[0] ?? DEFAULT_ACCOUNT_ID;
  const t = getChannelTrend(accountId);
  if (!t.latest) { console.log(`No history yet for "${accountId}" — it accumulates each time you run \`refresh-live\` or \`schedule\`'s Refresh.`); return; }
  console.log(`As of ${t.latest.date}: ${t.latest.subscriberCount} subscribers, ${t.latest.viewCount} total views, ${t.latest.videoCount} videos.`);
  if (t.last7Days) {
    console.log(`Last 7 days: +${t.last7Days.views} views, +${t.last7Days.subscribers} subs.`);
    if (t.prev7Days) console.log(`Previous 7 days: +${t.prev7Days.views} views, +${t.prev7Days.subscribers} subs.`);
  } else {
    console.log("Not enough history yet for a week-over-week trend (needs 8+ recorded days).");
  }
}

async function cmdComments() {
  const folder = resolve(positional[0] ?? ".");
  const entryId = positional[1];
  if (!entryId) { console.error('video id is required, e.g. comments "<folder>" "Bad Habit"'); process.exit(1); }
  const comments = await getEntryComments(folder, entryId);
  if (comments.length === 0) { console.log("No comments yet (or comments are off for this video)."); return; }
  for (const c of comments) {
    console.log(`[${c.id}] ${c.authorDisplayName} (👍${c.likeCount}, ${new Date(c.publishedAt).toLocaleDateString()}):`);
    console.log(`  ${c.textDisplay.replace(/\n/g, "\n  ")}`);
    if (c.totalReplyCount) console.log(`  (${c.totalReplyCount} replies)`);
  }
}

async function cmdCommentPost() {
  const folder = resolve(positional[0] ?? ".");
  const entryId = positional[1];
  const text = flags.get("text");
  if (!entryId || !text) { console.error('usage: comment-post "<folder>" "<video-id>" --text "..."'); process.exit(1); }
  const id = await postEntryComment(folder, entryId, text);
  console.log(`Posted comment ${id}.`);
}

async function cmdCommentReply() {
  const folder = resolve(positional[0] ?? ".");
  const parentId = positional[1];
  const text = flags.get("text");
  if (!parentId || !text) { console.error('usage: comment-reply "<folder>" "<parent-comment-id>" --text "..."'); process.exit(1); }
  const id = await replyToEntryComment(folder, parentId, text);
  console.log(`Posted reply ${id}.`);
}

function cmdSeoCheck() {
  const folder = resolve(positional[0] ?? ".");
  const entryId = positional[1];
  if (!entryId) { console.error('usage: seo-check "<folder>" "<video-id>"'); process.exit(1); }
  const queue = getQueueSnapshot(folder);
  const entry = queue.entries.find((e) => e.id === entryId);
  if (!entry) { console.error(`No queue entry "${entryId}" in ${folder}`); process.exit(1); }
  const report = checkSeo({ title: entry.title, description: entry.description, tags: entry.tags });
  console.log(`SEO score: ${report.score}%\n`);
  for (const c of report.checks) console.log(`${c.passed ? "✓" : "✗"} ${c.label}: ${c.message}`);
}

async function cmdKeywordSuggest() {
  const query = positional.join(" ");
  if (!query) { console.error('usage: keyword-suggest <query>'); process.exit(1); }
  const suggestions = await suggestKeywords(query);
  if (suggestions.length === 0) { console.log("No suggestions found."); return; }
  for (const s of suggestions) console.log(`  ${s}`);
}

async function cmdBulkEdit() {
  const folder = resolve(positional[0] ?? ".");
  const ids = flags.has("all")
    ? getQueueSnapshot(folder).entries.filter((e) => e.status === "uploaded").map((e) => e.id)
    : (flags.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) { console.error('specify --ids "id1,id2,..." or --all'); process.exit(1); }

  const patch = {};
  if (flags.has("add-tag")) patch.addTags = [flags.get("add-tag")];
  if (flags.has("remove-tag")) patch.removeTags = [flags.get("remove-tag")];
  if (flags.has("category")) patch.categoryId = flags.get("category");
  if (flags.has("privacy")) patch.privacyStatus = flags.get("privacy");
  if (flags.has("made-for-kids")) patch.madeForKids = true;
  if (flags.has("not-made-for-kids")) patch.madeForKids = false;

  console.log(`Applying to ${ids.length} video(s)…`);
  const result = await bulkUpdateEntries(folder, ids, patch, (id) => console.log(`  ${id}…`));
  console.log(`\nUpdated ${result.updated.length}/${ids.length}.`);
  if (result.quotaHit) console.log("Daily quota reached — re-run to continue with the rest.");
  for (const f of result.failed) console.log(`  FAILED ${f.id}: ${f.error}`);
}

async function cmdDashboard() {
  const dashboards = await getAllChannelDashboards();
  if (dashboards.length === 0) { console.log("No accounts registered yet."); return; }
  for (const d of dashboards) {
    console.log(`\n=== ${d.accountLabel}${d.channelTitle ? ` (${d.channelTitle})` : ""} ===`);
    if (d.lifetime) console.log(`Lifetime: ${d.lifetime.subscriberCount} subs, ${d.lifetime.viewCount} views, ${d.lifetime.videoCount} videos (as of ${d.lifetime.date})`);
    else console.log("No lifetime snapshot yet — run refresh-live at least once.");
    if (d.weekTrend) console.log(`Last 7 days: +${d.weekTrend.views} views, +${d.weekTrend.subscribers} subs`);
    if (d.last28Days) {
      const mins = Math.floor(d.last28Days.averageViewDuration / 60);
      const secs = Math.round(d.last28Days.averageViewDuration % 60);
      console.log(`Last 28 days: ${d.last28Days.views} views, ${Math.round(d.last28Days.estimatedMinutesWatched)} min watched, ${mins}:${String(secs).padStart(2, "0")} avg duration, ${d.last28Days.averageViewPercentage.toFixed(0)}% avg viewed, +${d.last28Days.subscribersGained}/-${d.last28Days.subscribersLost} subs`);
    } else if (d.error) {
      console.log(`Analytics unavailable: ${d.error}`);
    }
  }
}

function cmdAccountSet() {
  const folder = resolve(positional[0] ?? ".");
  const accountId = flags.get("account");
  if (!accountId) { console.error('--account is required, e.g. --account kids-books'); process.exit(1); }
  setQueueAccount(folder, accountId);
  console.log(`Folder now uploads via account "${accountId}".`);
}

try {
  switch (cmd) {
    case "init": await cmdInit(); break;
    case "add": await cmdAdd(); break;
    case "list": cmdList(); break;
    case "run": await cmdRun(); break;
    case "thumbnails": await cmdThumbnails(); break;
    case "playlist-set": cmdPlaylistSet(); break;
    case "sync-playlist": await cmdSyncPlaylist(); break;
    case "run-all": await cmdRunAll(); break;
    case "run-everything": await cmdRunEverything(); break;
    case "reschedule": cmdReschedule(); break;
    case "folders": cmdFolders(); break;
    case "schedule": cmdSchedule(); break;
    case "refresh-live": await cmdRefreshLive(); break;
    case "upload-settings-set": cmdUploadSettingsSet(); break;
    case "account-add": await cmdAccountAdd(); break;
    case "account-list": cmdAccountList(); break;
    case "account-remove": cmdAccountRemove(); break;
    case "account-reauth": await cmdAccountReauth(); break;
    case "analytics": await cmdAnalytics(); break;
    case "channel-health": cmdChannelHealth(); break;
    case "comments": await cmdComments(); break;
    case "comment-post": await cmdCommentPost(); break;
    case "comment-reply": await cmdCommentReply(); break;
    case "seo-check": cmdSeoCheck(); break;
    case "keyword-suggest": await cmdKeywordSuggest(); break;
    case "bulk-edit": await cmdBulkEdit(); break;
    case "dashboard": await cmdDashboard(); break;
    case "account-set": cmdAccountSet(); break;
    default: usageAndExit();
  }
} catch (err) {
  // Named errors (QuotaExceededError, AnalyticsScopeError, AnalyticsApiDisabledError, …)
  // have an actionable .message — show just that instead of a raw stack dump.
  console.error(`\n❌ ${err.message ?? err}`);
  process.exit(1);
}
