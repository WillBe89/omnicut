import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, watch, type FSWatcher,
} from "node:fs";
import { createProject, parseProject, type Project } from "@video-editor/core";
import { probeMedia, renderProject } from "@video-editor/engine-ffmpeg";
import { detectAgents, AgentSession } from "./agent.js";
import { registerYoutubeIpc } from "./youtube.js";

const HOME = process.env.VIDEO_EDITOR_HOME ?? join(homedir(), "VideoEditor");
const PROJECTS_DIR = join(HOME, "projects");
const RENDERS_DIR = join(HOME, "renders");
const WORK_DIR = join(HOME, ".work");
for (const d of [PROJECTS_DIR, RENDERS_DIR, WORK_DIR]) mkdirSync(d, { recursive: true });

// The MCP server entry, resolved relative to this bundle (apps/desktop/dist).
const MCP_SERVER_PATH = join(__dirname, "..", "..", "..", "packages", "mcp-server", "dist", "index.js");

let mainWindow: BrowserWindow | null = null;
let agentSession: AgentSession | null = null;
let activeProjectId: string | null = null;
let lastSelfWrite = 0; // ms timestamp of our own last write, to ignore self-triggered watch events
let watcher: FSWatcher | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "vfile",
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

function projectFilePath(id: string): string {
  return join(PROJECTS_DIR, `${id}.json`);
}

function persist(project: Project): void {
  lastSelfWrite = Date.now();
  writeFileSync(projectFilePath(project.id), JSON.stringify(project, null, 2), "utf8");
}

function listProjects() {
  return readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const path = join(PROJECTS_DIR, f);
      try {
        const p = parseProject(JSON.parse(readFileSync(path, "utf8")));
        return { id: p.id, name: p.name, path, updatedAt: p.updatedAt };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function mostRecentProject(): Project | null {
  const summaries = listProjects();
  if (summaries.length === 0) return null;
  try {
    return parseProject(JSON.parse(readFileSync(summaries[0]!.path, "utf8")));
  } catch {
    return null;
  }
}

/** Watch the active project's file so AI edits (via MCP) live-update the GUI. */
function watchActive(id: string): void {
  activeProjectId = id;
  watcher?.close();
  watcher = watch(PROJECTS_DIR, (_event, filename) => {
    if (!filename || !activeProjectId) return;
    if (filename !== `${activeProjectId}.json`) return;
    if (Date.now() - lastSelfWrite < 400) return; // ignore our own writes
    try {
      const p = parseProject(JSON.parse(readFileSync(projectFilePath(activeProjectId), "utf8")));
      mainWindow?.webContents.send("project:changed", p);
    } catch {
      /* mid-write; ignore */
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0b0d12",
    title: "OmniCut",
    icon: join(__dirname, "assets", "omnicut-icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(join(__dirname, "index.html"));
  mainWindow.on("closed", () => (mainWindow = null));
}

app.setName("OmniCut");

app.whenReady().then(() => {
  // Serve media files off disk to the renderer via vfile://
  protocol.handle("vfile", (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return net.fetch(pathToFileURL(filePath).toString());
  });

  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function registerIpc(): void {
  ipcMain.handle("app:getInitial", () => {
    const project = mostRecentProject();
    if (project) watchActive(project.id);
    return { home: HOME, project };
  });

  ipcMain.handle("project:create", (_e, name: string, settings: Partial<Project["settings"]>) => {
    const project = createProject(name, settings);
    persist(project);
    watchActive(project.id);
    return project;
  });

  ipcMain.handle("project:list", () => listProjects());

  ipcMain.handle("project:open", (_e, path: string) => {
    const project = parseProject(JSON.parse(readFileSync(path, "utf8")));
    watchActive(project.id);
    return project;
  });

  ipcMain.handle("project:save", (_e, project: Project) => {
    persist(project);
    if (activeProjectId !== project.id) watchActive(project.id);
  });

  ipcMain.handle("media:pick", async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Import media",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "m4v", "avi", "mp3", "wav", "m4a", "aac", "flac", "ogg", "png", "jpg", "jpeg", "webp", "bmp", "gif"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle("media:probe", async (_e, paths: string[]) => {
    const out = [];
    for (const p of paths) out.push(await probeMedia(p));
    return out;
  });

  ipcMain.handle("render:start", async (_e, project: Project, outputName?: string) => {
    const safe = (outputName ?? project.name).replace(/[^a-z0-9_\-]+/gi, "_") || "render";
    const outputPath = join(RENDERS_DIR, `${safe}.mp4`);
    const result = await renderProject(project, outputPath, {
      workDir: WORK_DIR,
      onProgress: (p) => mainWindow?.webContents.send("render:progress", p),
    });
    return result;
  });

  ipcMain.handle("shell:reveal", (_e, path: string) => shell.showItemInFolder(path));

  // ─────────────────────────────────────────────────────────────── AI agent
  ipcMain.handle("agent:detect", () => detectAgents());

  ipcMain.handle("agent:start", (_e, agentId?: string, mode?: "auto" | "plan") => {
    const agents = detectAgents();
    const agent = agents.find((a) => a.id === agentId) ?? agents[0];
    if (!agent) throw new Error("No agent CLI detected on your PATH (e.g. `claude`).");
    agentSession?.stop();
    agentSession = new AgentSession({
      agent,
      home: HOME,
      mcpServerPath: MCP_SERVER_PATH,
      activeProjectPath: activeProjectId ? projectFilePath(activeProjectId) : undefined,
      mode: mode ?? "auto",
      onEvent: (ev) => mainWindow?.webContents.send("agent:event", ev),
    });
    agentSession.start();
    return { agent };
  });

  ipcMain.handle("agent:send", (_e, text: string) => {
    if (!agentSession?.running) throw new Error("Agent is not running.");
    agentSession.send(text);
  });

  ipcMain.handle("agent:stop", () => {
    agentSession?.stop();
    agentSession = null;
  });

  registerYoutubeIpc(() => mainWindow);
}
