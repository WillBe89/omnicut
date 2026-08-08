/**
 * IPC surface for the Publish panel — thin wrappers around
 * @video-editor/youtube's manager/accounts functions, so the GUI has the
 * exact same capabilities as the CLI (scripts/youtube-queue.mjs), just as
 * buttons instead of commands.
 */
import { ipcMain, dialog, type BrowserWindow } from "electron";
import { basename } from "node:path";
import {
  listAccounts, addAccount, removeAccount, completeAccountAuth, reauthorizeAccount, setupFirstAccount,
  hasStoredCredentials, validateClientSecretFile,
  listKnownFoldersWithSummary, registerFolder, forgetFolder,
  getQueueSnapshot, addFolderToQueue, runQueueUploads, retryQueueThumbnails,
  setQueuePlaylist, setQueueAccount, previewPlaylistSync, syncQueuePlaylist,
  updateQueueEntry, rescheduleQueue, removeQueueEntry, runAllFolders,
  getUnifiedSchedule, refreshLiveStatus, setUploadDefaults, getVideoAnalytics, getChannelTrend,
  getEntryComments, postEntryComment, replyToEntryComment,
  checkSeo, suggestKeywords, bulkUpdateEntries, getAllChannelDashboards,
  type UploadDefaults, type QueueEntryPatch, type BulkEditPatch,
} from "@video-editor/youtube";
import { enableAutoSync, disableAutoSync, getAutoSyncStatus, runAutoSyncNow } from "./scheduler.js";

export function registerYoutubeIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle("yt:accounts:list", () => listAccounts());

  ipcMain.handle("yt:accounts:add", async (_e, id: string, label: string, clientSecretPath?: string) => {
    addAccount(id, label, clientSecretPath);
    const channel = await completeAccountAuth(id); // pops the user's browser for consent
    return { channel };
  });

  // ── Guided setup wizard (first-time YouTube connection) ──
  ipcMain.handle("yt:setup:hasCredentials", () => hasStoredCredentials());
  ipcMain.handle("yt:setup:validateClientSecret", (_e, path: string) => validateClientSecretFile(path));
  ipcMain.handle("yt:setup:firstAccount", async (_e, id: string, label: string, clientSecretPath: string) => {
    const channel = await setupFirstAccount(id, label, clientSecretPath); // pops the user's browser for consent
    return { channel };
  });

  ipcMain.handle("yt:accounts:remove", (_e, id: string) => removeAccount(id));

  ipcMain.handle("yt:accounts:pickClientSecret", async () => {
    const win = getWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: "Select the downloaded OAuth client JSON",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    return res.canceled ? null : res.filePaths[0]!;
  });

  ipcMain.handle("yt:folders:list", () => listKnownFoldersWithSummary());

  ipcMain.handle("yt:folders:pick", async () => {
    const win = getWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, { title: "Select a folder of rendered videos", properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    const path = res.filePaths[0];
    registerFolder(path, basename(path));
    return path;
  });

  ipcMain.handle("yt:folders:forget", (_e, path: string) => forgetFolder(path));

  ipcMain.handle("yt:queue:get", (_e, folder: string) => getQueueSnapshot(folder));

  ipcMain.handle("yt:queue:add", (_e, folder: string, opts: { everyDays?: number; startDate?: string; extraTags?: string[]; titlePrefix?: string; description?: string }) =>
    addFolderToQueue(folder, opts));

  ipcMain.handle("yt:queue:updateEntry", (_e, folder: string, entryId: string, patch: QueueEntryPatch) =>
    updateQueueEntry(folder, entryId, patch));

  ipcMain.handle("yt:queue:reschedule", (_e, folder: string, startDate: string, everyDays: number) =>
    rescheduleQueue(folder, startDate, everyDays));

  ipcMain.handle("yt:queue:removeEntry", (_e, folder: string, entryId: string) => removeQueueEntry(folder, entryId));

  ipcMain.handle("yt:queue:setAccount", (_e, folder: string, accountId: string) => setQueueAccount(folder, accountId));

  ipcMain.handle("yt:queue:run", async (_e, folder: string, limit?: number) => {
    const win = getWindow();
    return runQueueUploads(folder, {
      limit,
      onProgress: (ev) => win?.webContents.send("yt:upload:progress", { folder, ev }),
    });
  });

  ipcMain.handle("yt:queue:retryThumbnails", async (_e, folder: string) => {
    const win = getWindow();
    return retryQueueThumbnails(folder, (ev) => win?.webContents.send("yt:thumbnail:progress", { folder, ev }));
  });

  ipcMain.handle("yt:playlist:set", (_e, folder: string, config: { title: string; description?: string; privacyStatus: string }) =>
    setQueuePlaylist(folder, config as never));

  ipcMain.handle("yt:playlist:preview", (_e, folder: string) => previewPlaylistSync(folder));

  ipcMain.handle("yt:playlist:sync", async (_e, folder: string) => {
    const win = getWindow();
    return syncQueuePlaylist(folder, (msg) => win?.webContents.send("yt:sync:progress", { folder, msg }));
  });

  ipcMain.handle("yt:queue:runAll", async (_e, folders: string[]) => {
    const win = getWindow();
    return runAllFolders(folders, (folder, ev) => win?.webContents.send("yt:upload:progress", { folder, ev }));
  });

  // ── Cross-folder release schedule ──
  ipcMain.handle("yt:schedule:get", () => getUnifiedSchedule());
  ipcMain.handle("yt:schedule:refreshLive", (_e, folder: string) => refreshLiveStatus(folder));

  // ── Per-folder upload defaults (category, made-for-kids, license, …) ──
  ipcMain.handle("yt:uploadDefaults:set", (_e, folder: string, defaults: UploadDefaults) => setUploadDefaults(folder, defaults));

  // ── Analytics ──
  ipcMain.handle("yt:analytics:get", (_e, folder: string, entryId: string) => getVideoAnalytics(folder, entryId));

  // ── Channel health (views/subscribers gained this week vs last) ──
  ipcMain.handle("yt:channelHealth:get", (_e, accountId: string) => getChannelTrend(accountId));

  // ── Comments ──
  ipcMain.handle("yt:comments:list", (_e, folder: string, entryId: string) => getEntryComments(folder, entryId));
  ipcMain.handle("yt:comments:post", (_e, folder: string, entryId: string, text: string) => postEntryComment(folder, entryId, text));
  ipcMain.handle("yt:comments:reply", (_e, folder: string, parentId: string, text: string) => replyToEntryComment(folder, parentId, text));

  // ── SEO: deterministic checklist (no network) + keyword suggestions (public, no auth) ──
  ipcMain.handle("yt:seo:check", (_e, input: { title: string; description: string; tags: string[] }) => checkSeo(input));
  ipcMain.handle("yt:seo:suggestKeywords", (_e, query: string) => suggestKeywords(query));

  // ── Cross-channel dashboard ──
  ipcMain.handle("yt:dashboard:get", () => getAllChannelDashboards());

  // ── Bulk edit across many already-uploaded videos ──
  ipcMain.handle("yt:bulkUpdate", async (_e, folder: string, entryIds: string[], patch: BulkEditPatch) => {
    const win = getWindow();
    return bulkUpdateEntries(folder, entryIds, patch, (id) => win?.webContents.send("yt:bulkUpdate:progress", { folder, id }));
  });

  // ── Re-authorize an account (e.g. to grant a scope added after it was first connected) ──
  ipcMain.handle("yt:accounts:reauthorize", async (_e, id: string) => ({ channel: await reauthorizeAccount(id) }));

  // ── Scheduled (Windows Task Scheduler) automation ──
  ipcMain.handle("yt:auto:status", (_e, folder: string) => getAutoSyncStatus(folder));
  ipcMain.handle("yt:auto:enable", (_e, folder: string, time: string) => enableAutoSync(folder, time));
  ipcMain.handle("yt:auto:disable", (_e, folder: string) => disableAutoSync(folder));
  ipcMain.handle("yt:auto:runNow", (_e, folder: string) => runAutoSyncNow(folder));
}
