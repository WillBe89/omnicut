import type { MediaAsset, Project } from "@video-editor/core";
import type {
  Account, KnownFolder, Queue, QueueEntry, PrivacyStatus, UploadProgressEvent,
  SyncPlan, FolderRunResult, ScheduleItem, UploadDefaults, QueueEntryPatch, EntryAnalytics, ChannelTrend,
  CommentSummary, SeoReport, BulkEditPatch, BulkEditResult, ChannelDashboardData,
} from "@video-editor/youtube";

export type {
  Account, KnownFolder, Queue, QueueEntry, PrivacyStatus, UploadProgressEvent, SyncPlan, FolderRunResult,
  ScheduleItem, UploadDefaults, QueueEntryPatch, EntryAnalytics, ChannelTrend, CommentSummary, SeoReport,
  BulkEditPatch, BulkEditResult, ChannelDashboardData,
};

export interface FolderSummary extends KnownFolder {
  total: number;
  pending: number;
  uploaded: number;
  errored: number;
  playlist: Queue["playlist"] | null;
}

export interface AutoSyncStatus {
  enabled: boolean;
  time?: string;
  nextRun?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  updatedAt: string;
}

export interface RenderProgressEvent {
  fraction: number;
  outTime: number;
  duration: number;
  speed?: string;
}

export interface DetectedAgent {
  id: string;
  name: string;
  command: string;
  path: string;
  integrated: boolean;
}

/** Normalized agent-console events streamed from the main process. */
export type AgentEvent =
  | { kind: "ready"; tools: string[]; mcp: { name: string; status: string }[] }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "tool-result"; text: string; isError: boolean }
  | { kind: "status"; text: string }
  | { kind: "done"; text: string; isError: boolean }
  | { kind: "error"; text: string }
  | { kind: "exit"; code: number | null };

/** The surface exposed to the renderer via contextBridge as `window.api`. */
export interface DesktopAPI {
  getInitial(): Promise<{ home: string; project: Project | null }>;
  createProject(name: string, settings: Partial<Project["settings"]>): Promise<Project>;
  listProjects(): Promise<ProjectSummary[]>;
  openProject(path: string): Promise<Project>;
  saveProject(project: Project): Promise<void>;
  pickMediaFiles(): Promise<string[]>;
  probeMedia(paths: string[]): Promise<Omit<MediaAsset, "id">[]>;
  render(project: Project, outputName?: string): Promise<{ outputPath: string; duration: number }>;
  revealPath(path: string): Promise<void>;
  /** External change to the active project file (e.g. an AI edit via MCP). */
  onProjectChanged(cb: (project: Project) => void): () => void;
  onRenderProgress(cb: (p: RenderProgressEvent) => void): () => void;

  // AI agent console
  detectAgents(): Promise<DetectedAgent[]>;
  startAgent(agentId?: string, mode?: "auto" | "plan"): Promise<{ agent: DetectedAgent }>;
  sendAgent(text: string): Promise<void>;
  stopAgent(): Promise<void>;
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;

  // YouTube — accounts
  ytListAccounts(): Promise<Account[]>;
  ytAddAccount(id: string, label: string, clientSecretPath?: string): Promise<{ channel: string }>;
  ytRemoveAccount(id: string): Promise<void>;
  ytPickClientSecret(): Promise<string | null>;

  // YouTube — folders
  ytListFolders(): Promise<FolderSummary[]>;
  ytPickFolder(): Promise<string | null>;
  ytForgetFolder(path: string): Promise<void>;

  // YouTube — queue
  ytGetQueue(folder: string): Promise<Queue>;
  ytAddToQueue(folder: string, opts: { everyDays?: number; startDate?: string; extraTags?: string[]; titlePrefix?: string; description?: string }): Promise<{ id: string; publishAt: string }[]>;
  ytUpdateEntry(folder: string, entryId: string, patch: QueueEntryPatch): Promise<QueueEntry>;
  ytReschedule(folder: string, startDate: string, everyDays: number): Promise<QueueEntry[]>;
  ytRemoveEntry(folder: string, entryId: string): Promise<void>;
  ytSetAccount(folder: string, accountId: string): Promise<void>;
  ytRun(folder: string, limit?: number): Promise<{ uploaded: number; total: number; quotaHit: boolean }>;
  ytRunAll(folders: string[]): Promise<FolderRunResult[]>;
  ytRetryThumbnails(folder: string): Promise<{ fixed: number; total: number; quotaHit: boolean }>;
  onUploadProgress(cb: (e: { folder: string; ev: UploadProgressEvent }) => void): () => void;
  onThumbnailProgress(cb: (e: { folder: string; ev: { id: string; ok: boolean; error?: string } }) => void): () => void;

  // YouTube — cross-folder release schedule
  ytGetSchedule(): Promise<ScheduleItem[]>;
  ytRefreshLiveStatus(folder: string): Promise<QueueEntry[]>;

  // YouTube — per-folder upload defaults
  ytSetUploadDefaults(folder: string, defaults: UploadDefaults): Promise<void>;

  // YouTube — analytics
  ytGetAnalytics(folder: string, entryId: string): Promise<EntryAnalytics>;

  // YouTube — accounts
  ytReauthorizeAccount(id: string): Promise<{ channel: string }>;

  // YouTube — channel health trends
  ytGetChannelHealth(accountId: string): Promise<ChannelTrend>;

  // YouTube — comments
  ytListComments(folder: string, entryId: string): Promise<CommentSummary[]>;
  ytPostComment(folder: string, entryId: string, text: string): Promise<string>;
  ytReplyComment(folder: string, parentId: string, text: string): Promise<string>;

  // YouTube — SEO checklist + keyword suggestions
  ytCheckSeo(input: { title: string; description: string; tags: string[] }): Promise<SeoReport>;
  ytSuggestKeywords(query: string): Promise<string[]>;

  // YouTube — cross-channel dashboard
  ytGetDashboard(): Promise<ChannelDashboardData[]>;

  // YouTube — bulk edit across many already-uploaded videos
  ytBulkUpdate(folder: string, entryIds: string[], patch: BulkEditPatch): Promise<BulkEditResult>;
  onBulkUpdateProgress(cb: (e: { folder: string; id: string }) => void): () => void;

  // YouTube — playlist
  ytSetPlaylist(folder: string, config: { title: string; description?: string; privacyStatus: PrivacyStatus }): Promise<void>;
  ytPreviewSync(folder: string): Promise<SyncPlan>;
  ytSyncPlaylist(folder: string): Promise<{ playlistId: string; added: QueueEntry[]; quotaHit: boolean }>;
  onSyncProgress(cb: (e: { folder: string; msg: string }) => void): () => void;

  // YouTube — scheduled automation
  ytAutoStatus(folder: string): Promise<AutoSyncStatus>;
  ytAutoEnable(folder: string, time: string): Promise<void>;
  ytAutoDisable(folder: string): Promise<void>;
  ytAutoRunNow(folder: string): Promise<void>;
}

/** Build the vfile:// URL the renderer uses to load a media file off disk.
 *  `vfile` is registered as a standard scheme, which requires a host — hence
 *  the `local` authority; the encoded absolute path is the single path segment. */
export function toMediaUrl(absPath: string): string {
  return `vfile://local/${encodeURIComponent(absPath)}`;
}
