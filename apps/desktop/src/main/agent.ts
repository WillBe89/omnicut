/**
 * Embedded AI agent bridge.
 *
 * Auto-detects an agent CLI on the user's PATH and runs it in headless
 * streaming mode (Claude Code's stream-json protocol) wired to the video-editor
 * MCP server. The agent edits the shared project files; the app's file watcher
 * live-updates the timeline. No native modules — plain child_process pipes.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, DetectedAgent } from "../shared/ipc.js";

export type { AgentEvent, DetectedAgent };

interface KnownAgent {
  id: string;
  name: string;
  command: string;
  integrated: boolean;
}

const KNOWN_AGENTS: KnownAgent[] = [
  { id: "claude", name: "Claude Code", command: "claude", integrated: true },
  { id: "codex", name: "Codex CLI", command: "codex", integrated: false },
  { id: "gemini", name: "Gemini CLI", command: "gemini", integrated: false },
  { id: "aider", name: "Aider", command: "aider", integrated: false },
  { id: "opencode", name: "opencode", command: "opencode", integrated: false },
];

function resolveCommand(command: string): string | null {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(finder, [command], { encoding: "utf8" });
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

export function detectAgents(): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const a of KNOWN_AGENTS) {
    const path = resolveCommand(a.command);
    if (path) found.push({ id: a.id, name: a.name, command: a.command, path, integrated: a.integrated });
  }
  return found;
}

export type AgentMode = "auto" | "plan";

export interface StartOptions {
  agent: DetectedAgent;
  /** Shared VIDEO_EDITOR_HOME so the agent's MCP server matches the app. */
  home: string;
  /** Absolute path to the packaged MCP server entry (index.js). */
  mcpServerPath: string;
  /** Active project file, so the agent edits the same project the GUI shows. */
  activeProjectPath?: string;
  /** "auto" runs edits immediately; "plan" makes the agent propose & wait for approval. */
  mode: AgentMode;
  onEvent: (e: AgentEvent) => void;
}

export class AgentSession {
  private child: ChildProcess | null = null;
  private buffer = "";
  private readonly opts: StartOptions;

  constructor(opts: StartOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this.child !== null && !this.child.killed;
  }

  start(): void {
    const { agent, home, mcpServerPath, onEvent } = this.opts;
    if (!agent.integrated) {
      onEvent({ kind: "error", text: `${agent.name} isn't auto-wired yet. Only Claude Code is integrated so far.` });
      return;
    }

    const agentDir = join(home, ".agent");
    mkdirSync(agentDir, { recursive: true });

    // MCP config: the agent's video-editor server shares the app's HOME.
    const mcpConfigPath = join(agentDir, "mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        { mcpServers: { "video-editor": { command: "node", args: [mcpServerPath], env: { VIDEO_EDITOR_HOME: home } } } },
        null,
        2,
      ),
      "utf8",
    );

    // Orientation for the agent (picked up as CLAUDE.md in cwd=home).
    const planBlock = this.opts.mode === "plan"
      ? [
          "",
          "## APPROVAL REQUIRED (Plan-first mode)",
          "Before calling ANY tool that changes the project (anything except",
          "get_timeline / list_projects / open_project), you MUST first reply with a",
          "short numbered list of the exact edits you intend to make, then STOP and",
          "wait. Do NOT call editing tools until the user replies 'go' (or 'yes').",
          "Once approved, execute the whole plan, then briefly confirm what you did.",
        ]
      : [];
    writeFileSync(
      join(home, "CLAUDE.md"),
      [
        "# OmniCut — AI editing assistant",
        "",
        "You are embedded inside the OmniCut desktop video editor. Edit the user's",
        "timeline using the **video-editor** MCP tools (create_project, import_media,",
        "add_clip, trim_clip, split_clip, set_transition, add_text, set_clip_speed, render, …).",
        "",
        "- Call `get_timeline` whenever you need to see the current state and clip ids.",
        "- The app will tell you the active project path at the start of the session —",
        "  `open_project` it before editing so your edits show up in the GUI.",
        "- Prefer MCP tools over shell commands. Keep replies concise.",
        ...planBlock,
      ].join("\n"),
      "utf8",
    );

    const args = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
      "--strict-mcp-config",
      "--mcp-config", quote(mcpConfigPath),
    ];
    const command = `${quote(agent.path)} ${args.join(" ")}`;

    this.child = spawn(command, {
      cwd: home,
      shell: true,
      env: process.env,
      windowsHide: true,
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      const t = chunk.trim();
      if (t) onEvent({ kind: "status", text: t.slice(0, 400) });
    });
    this.child.on("error", (err) => onEvent({ kind: "error", text: err.message }));
    this.child.on("close", (code) => {
      onEvent({ kind: "exit", code });
      this.child = null;
    });

    // Seed the session so the agent opens the active project.
    if (this.opts.activeProjectPath) {
      this.send(
        `The active project file is: ${this.opts.activeProjectPath}\n` +
          `Silently call open_project on it, then reply with a one-line "Ready — editing <project name>." Do not make other changes yet.`,
      );
    }
  }

  send(text: string): void {
    if (!this.child?.stdin) {
      this.opts.onEvent({ kind: "error", text: "Agent is not running." });
      return;
    }
    const msg = { type: "user", message: { role: "user", content: text } };
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  stop(): void {
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = null;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const { onEvent } = this.opts;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore non-JSON noise
    }

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          onEvent({ kind: "ready", tools: msg.tools ?? [], mcp: msg.mcp_servers ?? [] });
        } else if (msg.subtype === "api_retry") {
          onEvent({ kind: "status", text: `Retrying (${msg.error_status ?? ""})…` });
        }
        break;
      case "assistant": {
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            onEvent({ kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            onEvent({ kind: "tool", name: block.name, input: block.input });
          }
        }
        break;
      }
      case "user": {
        // Tool results are echoed back as user messages.
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === "tool_result") {
            const text = Array.isArray(block.content)
              ? block.content.map((c: any) => c.text ?? "").join("\n")
              : String(block.content ?? "");
            onEvent({ kind: "tool-result", text: text.slice(0, 600), isError: Boolean(block.is_error) });
          }
        }
        break;
      }
      case "result":
        onEvent({ kind: "done", text: msg.result ?? "", isError: Boolean(msg.is_error) });
        break;
    }
  }
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
