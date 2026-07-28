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
  listAccounts, addAccount, removeAccount, completeAccountAuth, DEFAULT_ACCOUNT_ID,
  runAllFolders,
} from "@video-editor/youtube";

const [, , cmd, ...rest] = process.argv;
const flags = new Map();
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) { flags.set(rest[i].slice(2), rest[i + 1]); i++; }
  else positional.push(rest[i]);
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
    "  node scripts/youtube-queue.mjs account-add <id> --label \"...\" [--client-secret <path>]\n" +
    "  node scripts/youtube-queue.mjs account-list\n" +
    "  node scripts/youtube-queue.mjs account-remove <id>\n" +
    "  node scripts/youtube-queue.mjs account-set <folder> --account <id>",
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

function cmdAccountSet() {
  const folder = resolve(positional[0] ?? ".");
  const accountId = flags.get("account");
  if (!accountId) { console.error('--account is required, e.g. --account kids-books'); process.exit(1); }
  setQueueAccount(folder, accountId);
  console.log(`Folder now uploads via account "${accountId}".`);
}

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
  case "account-add": await cmdAccountAdd(); break;
  case "account-list": cmdAccountList(); break;
  case "account-remove": cmdAccountRemove(); break;
  case "account-set": cmdAccountSet(); break;
  default: usageAndExit();
}
