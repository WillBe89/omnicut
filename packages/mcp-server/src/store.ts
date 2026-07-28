import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { parseProject, type Project } from "@video-editor/core";

/**
 * Holds the single active project for an MCP session, with disk persistence
 * and an undo/redo history. All edit tools go through `update()` so history
 * and autosave stay consistent.
 */
export class ProjectStore {
  readonly home: string;
  readonly projectsDir: string;
  readonly rendersDir: string;
  readonly workDir: string;

  private project: Project | null = null;
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private readonly maxHistory = 50;

  constructor(home = process.env.VIDEO_EDITOR_HOME ?? join(homedir(), "VideoEditor")) {
    this.home = home;
    this.projectsDir = join(home, "projects");
    this.rendersDir = join(home, "renders");
    this.workDir = join(home, ".work");
    for (const d of [this.projectsDir, this.rendersDir, this.workDir]) {
      mkdirSync(d, { recursive: true });
    }
  }

  get current(): Project {
    if (!this.project) {
      throw new Error(
        "No active project. Call create_project or open_project first.",
      );
    }
    return this.project;
  }

  hasProject(): boolean {
    return this.project !== null;
  }

  /** Replace the active project without touching history (create/open). */
  set(project: Project): void {
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.autosave();
  }

  /** Apply an edit, snapshotting the previous state for undo. */
  update(fn: (p: Project) => Project): Project {
    const prev = this.current;
    const next = fn(prev);
    this.undoStack.push(prev);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
    this.project = next;
    this.autosave();
    return next;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev || !this.project) return false;
    this.redoStack.push(this.project);
    this.project = prev;
    this.autosave();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next || !this.project) return false;
    this.undoStack.push(this.project);
    this.project = next;
    this.autosave();
    return true;
  }

  projectPath(id = this.current.id): string {
    return join(this.projectsDir, `${id}.json`);
  }

  save(path?: string): string {
    const target = path ?? this.projectPath();
    writeFileSync(target, JSON.stringify(this.current, null, 2), "utf8");
    return target;
  }

  load(path: string): Project {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const project = parseProject(raw);
    this.set(project);
    return project;
  }

  private autosave(): void {
    if (this.project) {
      try {
        writeFileSync(this.projectPath(), JSON.stringify(this.project, null, 2), "utf8");
      } catch {
        /* best-effort */
      }
    }
  }
}
