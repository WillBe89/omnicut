import { useEffect, useRef, useState } from "react";
import type { AgentEvent, DetectedAgent } from "../shared/ipc.js";

type Status = "disconnected" | "connecting" | "ready" | "busy" | "error";

interface Line {
  id: number;
  role: "user" | "assistant" | "tool" | "tool-error" | "status" | "system";
  text: string;
}

const TOOL_LABEL: Record<string, string> = {
  create_project: "🎬 New project", import_media: "📥 Import", add_clip: "➕ Add clip",
  trim_clip: "✂️ Trim", split_clip: "✂️ Split", move_clip: "↔️ Move", delete_clip: "🗑️ Delete",
  ripple_delete: "🗑️ Ripple delete", set_clip_speed: "⏩ Speed", set_clip_volume: "🔊 Volume",
  set_transition: "🎞️ Transition", add_text: "🔤 Text", update_text: "🔤 Text",
  set_clip_fades: "🌗 Fade", set_clip_audio_fades: "🎚️ Audio fade", set_clip_transform: "🎯 Transform",
  render: "🎥 Render", get_timeline: "👁️ Read timeline", open_project: "📂 Open", save_project: "💾 Save",
};

function toolLabel(name: string): string {
  const bare = name.replace(/^mcp__video-editor__/, "");
  return TOOL_LABEL[bare] ?? `🔧 ${bare}`;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== "")
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v.slice(0, 30) : JSON.stringify(v)}`);
  return entries.join(", ");
}

export function AgentConsole({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [status, setStatus] = useState<Status>("disconnected");
  const [mode, setMode] = useState<"auto" | "plan">("auto");
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const push = (role: Line["role"], text: string) =>
    setLines((ls) => [...ls, { id: idRef.current++, role, text }]);

  useEffect(() => {
    window.api.detectAgents().then((list) => {
      setAgents(list);
      if (list[0]) setAgentId(list[0].id);
    });
    const unsub = window.api.onAgentEvent((e: AgentEvent) => {
      switch (e.kind) {
        case "ready": {
          const mcp = e.mcp.map((m) => m.name).join(", ") || "none";
          push("system", `Connected · ${e.tools.length} tools · MCP: ${mcp}`);
          setStatus((s) => (s === "busy" ? "busy" : "ready"));
          break;
        }
        case "text": push("assistant", e.text); break;
        case "tool":
          push("tool", `${toolLabel(e.name)}  ${summarizeInput(e.input)}`);
          setStatus("busy");
          break;
        case "tool-result": if (e.isError) push("tool-error", e.text); break;
        case "status": push("status", e.text); break;
        case "done": setStatus(e.isError ? "error" : "ready"); if (e.isError && e.text) push("tool-error", e.text); break;
        case "error": push("tool-error", e.text); setStatus("error"); break;
        case "exit": push("system", `Agent exited${e.code ? ` (code ${e.code})` : ""}.`); setStatus("disconnected"); break;
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  const connect = async () => {
    setStatus("connecting");
    setLines([]);
    try {
      const { agent } = await window.api.startAgent(agentId, mode);
      push("system", `Starting ${agent.name}… (${mode === "plan" ? "Plan-first" : "Auto-run"})`);
    } catch (err) {
      push("tool-error", (err as Error).message);
      setStatus("error");
    }
  };

  const disconnect = async () => {
    await window.api.stopAgent();
    setStatus("disconnected");
  };

  const send = async () => {
    const text = input.trim();
    if (!text || status === "busy" || status === "connecting") return;
    push("user", text);
    setInput("");
    setStatus("busy");
    try {
      await window.api.sendAgent(text);
    } catch (err) {
      push("tool-error", (err as Error).message);
      setStatus("error");
    }
  };

  const connected = status === "ready" || status === "busy";
  const statusText: Record<Status, string> = {
    disconnected: "Not connected", connecting: "Connecting…", ready: "Ready", busy: "Working…", error: "Error",
  };

  return (
    <div className="agent">
      <div className="agent-head">
        <span className="agent-title">🤖 AI Editor</span>
        <span className={`agent-dot ${status}`} />
        <span className="agent-status">{statusText[status]}</span>
        <div className="spacer" />
        {!connected ? (
          <>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={agents.length === 0}>
              {agents.length === 0 && <option>No agent found</option>}
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.integrated ? "" : " (not wired)"}</option>)}
            </select>
            <div className="mode-toggle" title="Plan-first makes the agent propose edits and wait for your 'go'.">
              <button className={mode === "auto" ? "on" : ""} onClick={() => setMode("auto")}>Auto</button>
              <button className={mode === "plan" ? "on" : ""} onClick={() => setMode("plan")}>Plan first</button>
            </div>
            <button className="primary" onClick={connect} disabled={agents.length === 0 || status === "connecting"}>Connect</button>
          </>
        ) : (
          <button onClick={disconnect}>Disconnect</button>
        )}
        <button onClick={onClose} title="Close">✕</button>
      </div>

      <div className="agent-transcript" ref={scrollRef}>
        {lines.length === 0 && status === "disconnected" && (
          <div className="agent-empty">
            <p>Connect an agent, then describe the edit you want in plain language.</p>
            <p className="eg">"Trim the intro to 5 seconds, add a title 'Summer 2026', put the music under it at 30% with a 2s fade-out, then render."</p>
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} className={`agent-line ${l.role}`}>
            {l.role === "user" && <span className="who">You</span>}
            <div className="bubble">{l.text}</div>
          </div>
        ))}
      </div>

      <div className="agent-input">
        <textarea
          value={input}
          placeholder={connected ? "Describe an edit…" : "Connect an agent to start"}
          disabled={!connected}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button className="primary" onClick={send} disabled={!connected || status === "busy" || !input.trim()}>Send</button>
      </div>
    </div>
  );
}
