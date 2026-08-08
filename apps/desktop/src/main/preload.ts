import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, DesktopAPI, RenderProgressEvent, UploadProgressEvent } from "../shared/ipc.js";
import type { Project } from "@video-editor/core";

const api: DesktopAPI = {
  getInitial: () => ipcRenderer.invoke("app:getInitial"),
  createProject: (name, settings) => ipcRenderer.invoke("project:create", name, settings),
  listProjects: () => ipcRenderer.invoke("project:list"),
  openProject: (path) => ipcRenderer.invoke("project:open", path),
  saveProject: (project) => ipcRenderer.invoke("project:save", project),
  pickMediaFiles: () => ipcRenderer.invoke("media:pick"),
  probeMedia: (paths) => ipcRenderer.invoke("media:probe", paths),
  render: (project, outputName) => ipcRenderer.invoke("render:start", project, outputName),
  revealPath: (path) => ipcRenderer.invoke("shell:reveal", path),
  onProjectChanged: (cb: (p: Project) => void) => {
    const handler = (_e: unknown, p: Project) => cb(p);
    ipcRenderer.on("project:changed", handler);
    return () => ipcRenderer.removeListener("project:changed", handler);
  },
  onRenderProgress: (cb: (p: RenderProgressEvent) => void) => {
    const handler = (_e: unknown, p: RenderProgressEvent) => cb(p);
    ipcRenderer.on("render:progress", handler);
    return () => ipcRenderer.removeListener("render:progress", handler);
  },

  detectAgents: () => ipcRenderer.invoke("agent:detect"),
  startAgent: (agentId, mode) => ipcRenderer.invoke("agent:start", agentId, mode),
  sendAgent: (text) => ipcRenderer.invoke("agent:send", text),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  onAgentEvent: (cb: (e: AgentEvent) => void) => {
    const handler = (_e: unknown, ev: AgentEvent) => cb(ev);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },

  ytListAccounts: () => ipcRenderer.invoke("yt:accounts:list"),
  ytAddAccount: (id, label, clientSecretPath) => ipcRenderer.invoke("yt:accounts:add", id, label, clientSecretPath),
  ytRemoveAccount: (id) => ipcRenderer.invoke("yt:accounts:remove", id),
  ytPickClientSecret: () => ipcRenderer.invoke("yt:accounts:pickClientSecret"),
  ytHasCredentials: () => ipcRenderer.invoke("yt:setup:hasCredentials"),
  ytValidateClientSecret: (path) => ipcRenderer.invoke("yt:setup:validateClientSecret", path),
  ytSetupFirstAccount: (id, label, clientSecretPath) => ipcRenderer.invoke("yt:setup:firstAccount", id, label, clientSecretPath),

  ytListFolders: () => ipcRenderer.invoke("yt:folders:list"),
  ytPickFolder: () => ipcRenderer.invoke("yt:folders:pick"),
  ytForgetFolder: (path) => ipcRenderer.invoke("yt:folders:forget", path),

  ytGetQueue: (folder) => ipcRenderer.invoke("yt:queue:get", folder),
  ytAddToQueue: (folder, opts) => ipcRenderer.invoke("yt:queue:add", folder, opts),
  ytUpdateEntry: (folder, entryId, patch) => ipcRenderer.invoke("yt:queue:updateEntry", folder, entryId, patch),
  ytReschedule: (folder, startDate, everyDays) => ipcRenderer.invoke("yt:queue:reschedule", folder, startDate, everyDays),
  ytRemoveEntry: (folder, entryId) => ipcRenderer.invoke("yt:queue:removeEntry", folder, entryId),
  ytSetAccount: (folder, accountId) => ipcRenderer.invoke("yt:queue:setAccount", folder, accountId),
  ytRun: (folder, limit) => ipcRenderer.invoke("yt:queue:run", folder, limit),
  ytRunAll: (folders) => ipcRenderer.invoke("yt:queue:runAll", folders),
  ytRetryThumbnails: (folder) => ipcRenderer.invoke("yt:queue:retryThumbnails", folder),
  ytGetSchedule: () => ipcRenderer.invoke("yt:schedule:get"),
  ytRefreshLiveStatus: (folder) => ipcRenderer.invoke("yt:schedule:refreshLive", folder),
  ytSetUploadDefaults: (folder, defaults) => ipcRenderer.invoke("yt:uploadDefaults:set", folder, defaults),
  ytGetAnalytics: (folder, entryId) => ipcRenderer.invoke("yt:analytics:get", folder, entryId),
  ytReauthorizeAccount: (id) => ipcRenderer.invoke("yt:accounts:reauthorize", id),
  ytGetChannelHealth: (accountId) => ipcRenderer.invoke("yt:channelHealth:get", accountId),
  ytListComments: (folder, entryId) => ipcRenderer.invoke("yt:comments:list", folder, entryId),
  ytPostComment: (folder, entryId, text) => ipcRenderer.invoke("yt:comments:post", folder, entryId, text),
  ytReplyComment: (folder, parentId, text) => ipcRenderer.invoke("yt:comments:reply", folder, parentId, text),
  ytCheckSeo: (input) => ipcRenderer.invoke("yt:seo:check", input),
  ytSuggestKeywords: (query) => ipcRenderer.invoke("yt:seo:suggestKeywords", query),
  ytGetDashboard: () => ipcRenderer.invoke("yt:dashboard:get"),
  ytBulkUpdate: (folder, entryIds, patch) => ipcRenderer.invoke("yt:bulkUpdate", folder, entryIds, patch),
  onBulkUpdateProgress: (cb: (e: { folder: string; id: string }) => void) => {
    const handler = (_e: unknown, data: { folder: string; id: string }) => cb(data);
    ipcRenderer.on("yt:bulkUpdate:progress", handler);
    return () => ipcRenderer.removeListener("yt:bulkUpdate:progress", handler);
  },
  onUploadProgress: (cb: (e: { folder: string; ev: UploadProgressEvent }) => void) => {
    const handler = (_e: unknown, data: { folder: string; ev: UploadProgressEvent }) => cb(data);
    ipcRenderer.on("yt:upload:progress", handler);
    return () => ipcRenderer.removeListener("yt:upload:progress", handler);
  },
  onThumbnailProgress: (cb: (e: { folder: string; ev: { id: string; ok: boolean; error?: string } }) => void) => {
    const handler = (_e: unknown, data: { folder: string; ev: { id: string; ok: boolean; error?: string } }) => cb(data);
    ipcRenderer.on("yt:thumbnail:progress", handler);
    return () => ipcRenderer.removeListener("yt:thumbnail:progress", handler);
  },

  ytSetPlaylist: (folder, config) => ipcRenderer.invoke("yt:playlist:set", folder, config),
  ytPreviewSync: (folder) => ipcRenderer.invoke("yt:playlist:preview", folder),
  ytSyncPlaylist: (folder) => ipcRenderer.invoke("yt:playlist:sync", folder),
  onSyncProgress: (cb: (e: { folder: string; msg: string }) => void) => {
    const handler = (_e: unknown, data: { folder: string; msg: string }) => cb(data);
    ipcRenderer.on("yt:sync:progress", handler);
    return () => ipcRenderer.removeListener("yt:sync:progress", handler);
  },

  ytAutoStatus: (folder) => ipcRenderer.invoke("yt:auto:status", folder),
  ytAutoEnable: (folder, time) => ipcRenderer.invoke("yt:auto:enable", folder, time),
  ytAutoDisable: (folder) => ipcRenderer.invoke("yt:auto:disable", folder),
  ytAutoRunNow: (folder) => ipcRenderer.invoke("yt:auto:runNow", folder),
};

contextBridge.exposeInMainWorld("api", api);
