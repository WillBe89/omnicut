export { authorize } from "./auth.js";
export type { OAuth2Client } from "./auth.js";
export { extractThumbnail } from "./thumbnail.js";
export { loadQueue, saveQueue } from "./queue.js";
export type { Queue, QueueEntry, PrivacyStatus, EntryStatus, PlaylistConfig, UploadDefaults } from "./queue.js";
export { uploadVideo, setThumbnail, QuotaExceededError } from "./upload.js";
export type { UploadResult } from "./upload.js";
export {
  listMyPlaylists, getOrCreatePlaylist, listPlaylistVideoIds, addVideoToPlaylist, fetchLiveStatus,
} from "./playlists.js";
export type { PlaylistSummary, VideoStatus } from "./playlists.js";
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
  refreshLiveStatus, getUnifiedSchedule, setUploadDefaults, getVideoAnalytics,
  getEntryComments, postEntryComment, replyToEntryComment, bulkUpdateEntries,
  getChannelDashboard, getAllChannelDashboards,
} from "./manager.js";
export type {
  AddOptions, AddedEntry, UploadProgressEvent, RunResult, ThumbResult, SyncOutcome, FolderRunResult,
  ScheduleItem, QueueEntryPatch, EntryAnalytics, BulkEditPatch, BulkEditResult, ChannelDashboardData,
} from "./manager.js";
export type { CommentSummary } from "./comments.js";
export { CommentsScopeError } from "./comments.js";
export { updateLiveVideo } from "./upload.js";
export type { LiveVideoPatch } from "./upload.js";
export { fetchVideoAnalytics, fetchTrafficSources, fetchChannelDailyTotals, AnalyticsScopeError, AnalyticsApiDisabledError } from "./analytics.js";
export type { VideoAnalytics, TrafficSource, ChannelDayTotals } from "./analytics.js";
export { getChannelTrend } from "./channelhealth.js";
export type { ChannelSnapshot, ChannelTrend } from "./channelhealth.js";
export { checkSeo, suggestKeywords } from "./seo.js";
export type { SeoCheck, SeoReport } from "./seo.js";
export {
  listKnownFolders, listKnownFoldersWithSummary, registerFolder, forgetFolder,
} from "./registry.js";
export type { KnownFolder } from "./registry.js";
export {
  DEFAULT_ACCOUNT_ID, listAccounts, getAccount, addAccount, removeAccount, withAccountAuth, completeAccountAuth,
  reauthorizeAccount,
} from "./accounts.js";
export type { Account } from "./accounts.js";
