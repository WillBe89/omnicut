export { authorize } from "./auth.js";
export type { OAuth2Client } from "./auth.js";
export { extractThumbnail } from "./thumbnail.js";
export { loadQueue, saveQueue } from "./queue.js";
export type { Queue, QueueEntry, PrivacyStatus, EntryStatus, PlaylistConfig } from "./queue.js";
export { uploadVideo, setThumbnail, QuotaExceededError } from "./upload.js";
export type { UploadResult } from "./upload.js";
export {
  listMyPlaylists, getOrCreatePlaylist, listPlaylistVideoIds, addVideoToPlaylist, fetchLiveStatus,
} from "./playlists.js";
export type { PlaylistSummary } from "./playlists.js";
export { planPlaylistSync, runPlaylistSync } from "./sync.js";
export type { SyncPlan } from "./sync.js";
export { updateVideoSchedule } from "./schedule.js";
export {
  CREDENTIALS_DIR, CLIENT_SECRET_PATH, TOKEN_PATH, hasStoredCredentials, hasStoredToken, authorizeStored,
} from "./credentials.js";
export {
  queuePathFor, getQueueSnapshot, addFolderToQueue, runQueueUploads, retryQueueThumbnails,
  setQueuePlaylist, setQueueAccount, previewPlaylistSync, syncQueuePlaylist,
  updateQueueEntry, rescheduleQueue, removeQueueEntry, runAllFolders,
} from "./manager.js";
export type {
  AddOptions, AddedEntry, UploadProgressEvent, RunResult, ThumbResult, SyncOutcome, FolderRunResult,
} from "./manager.js";
export {
  listKnownFolders, listKnownFoldersWithSummary, registerFolder, forgetFolder,
} from "./registry.js";
export type { KnownFolder } from "./registry.js";
export {
  DEFAULT_ACCOUNT_ID, listAccounts, getAccount, addAccount, removeAccount, withAccountAuth, completeAccountAuth,
} from "./accounts.js";
export type { Account } from "./accounts.js";
