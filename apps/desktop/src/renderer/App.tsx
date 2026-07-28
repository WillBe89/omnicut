import { useEffect, useRef, useState } from "react";
import { formatTimecode, getAsset, projectDuration } from "@video-editor/core";
import { useEditor } from "./useEditor.js";
import { Preview } from "./Preview.js";
import { Timeline } from "./Timeline.js";
import { Inspector } from "./Inspector.js";
import { AgentConsole } from "./AgentConsole.js";
import { PublishPanel } from "./PublishPanel.js";
// PNG assets are inlined as data-URLs by esbuild's dataurl loader at build time.
// @ts-ignore - handled by the bundler, not tsc
import logoUrl from "../../assets/omnicut-logo.png";
// @ts-ignore - handled by the bundler, not tsc
import iconUrl from "../../assets/omnicut-icon.png";

const PRESETS = [
  { label: "1080p Landscape", width: 1920, height: 1080 },
  { label: "Vertical / Shorts", width: 1080, height: 1920 },
  { label: "Square", width: 1080, height: 1080 },
];

export function App() {
  const ed = useEditor();
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [render, setRender] = useState<{ pct: number; path?: string; running: boolean } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const clockRef = useRef<{ last: number } | null>(null);

  const project = ed.project;
  const total = project ? projectDuration(project) : 0;

  // Playback clock.
  useEffect(() => {
    if (!playing) {
      clockRef.current = null;
      return;
    }
    let raf = 0;
    clockRef.current = { last: performance.now() };
    const tick = (now: number) => {
      const c = clockRef.current;
      if (c) {
        const dt = (now - c.last) / 1000;
        c.last = now;
        setTime((t) => {
          const nt = t + dt;
          if (nt >= total) {
            setPlaying(false);
            return total;
          }
          return nt;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  // Render progress subscription.
  useEffect(() => window.api.onRenderProgress((p) => setRender((r) => ({ ...(r ?? { running: true }), pct: Math.round(p.fraction * 100), running: true }))), []);

  const doExport = async () => {
    if (!project) return;
    setRender({ pct: 0, running: true });
    try {
      const res = await window.api.render(project);
      setRender({ pct: 100, path: res.outputPath, running: false });
    } catch (e) {
      setRender(null);
      alert(`Render failed:\n${(e as Error).message}`);
    }
  };

  if (ed.loading) return <div className="center-msg">Loading…</div>;

  return (
    <div className="app">
      <header className="toolbar">
        <img className="brand-logo" src={logoUrl} alt="OmniCut" />
        <button onClick={() => setShowNew(true)}>New</button>
        <button onClick={ed.importMedia} disabled={!project}>Import media…</button>
        <button onClick={() => { ed.addTitle({ content: "New title", start: time, duration: 3 }); }} disabled={!project}>+ Text</button>
        <button className={showAgent ? "primary" : ""} onClick={() => setShowAgent((v) => !v)}>🤖 AI Editor</button>
        <button className={showPublish ? "primary" : ""} onClick={() => setShowPublish((v) => !v)}>📤 Publish</button>
        <div className="spacer" />
        <button onClick={ed.undo} disabled={!ed.canUndo}>↶ Undo</button>
        <button onClick={ed.redo} disabled={!ed.canRedo}>↷ Redo</button>
        <button className="primary" onClick={doExport} disabled={!project || render?.running}>
          {render?.running ? `Rendering ${render.pct}%` : "Export MP4"}
        </button>
      </header>

      {render && !render.running && render.path && (
        <div className="banner">
          Exported to <code>{render.path}</code>
          <button onClick={() => window.api.revealPath(render.path!)}>Show in folder</button>
          <button onClick={() => setRender(null)}>✕</button>
        </div>
      )}

      {!project ? (
        <div className="welcome">
          <img className="welcome-logo" src={iconUrl} alt="OmniCut" />
          <h1>OmniCut</h1>
          <p>Deterministic video editing — drive it yourself or let the AI do it.</p>
          <button className="primary" onClick={() => setShowNew(true)}>Create a project</button>
        </div>
      ) : (
        <div className="body">
          <aside className="media-bin">
            <h3>Media</h3>
            {project.media.length === 0 && <p className="hint">Import video, audio, or images to begin.</p>}
            {project.media.map((m) => (
              <div key={m.id} className="media-item" onDoubleClick={() => ed.addToTimeline(m)} title="Double-click to add to timeline">
                <span className={`badge ${m.type}`}>{m.type.charAt(0).toUpperCase()}</span>
                <span className="media-name">{m.name}</span>
                <span className="media-dur">{m.duration ? formatTimecode(m.duration) : "still"}</span>
              </div>
            ))}
          </aside>

          <main className="stage-area">
            <Preview project={project} time={time} playing={playing} selectedClipId={ed.selectedClipId} onSelect={ed.select} />
            <div className="transport">
              <button onClick={() => setPlaying((p) => !p)}>{playing ? "⏸" : "▶"}</button>
              <button onClick={() => { setPlaying(false); setTime(0); }}>⏮</button>
              <span className="tc">{formatTimecode(time)} / {formatTimecode(total)}</span>
              <input className="scrub" type="range" min={0} max={Math.max(total, 0.1)} step={0.01} value={Math.min(time, total)} onChange={(e) => { setPlaying(false); setTime(parseFloat(e.target.value)); }} />
              <button onClick={() => ed.selectedClipId && ed.splitAt(ed.selectedClipId, time)} disabled={!ed.selectedClipId}>✂ Split</button>
            </div>
          </main>

          <aside className="inspector-panel">
            <Inspector project={project} ed={ed} />
          </aside>
        </div>
      )}

      {project && (
        <Timeline
          project={project}
          time={time}
          selectedClipId={ed.selectedClipId}
          onSeek={(t) => { setPlaying(false); setTime(t); }}
          onSelect={ed.select}
          onMoveClip={ed.moveClipTo}
        />
      )}

      {showNew && <NewProjectModal onCancel={() => setShowNew(false)} onCreate={(name, s) => { ed.newProject(name, s); setShowNew(false); setTime(0); }} />}

      {showAgent && (
        <div className="agent-drawer">
          <AgentConsole onClose={() => setShowAgent(false)} />
        </div>
      )}

      {showPublish && (
        <div className="publish-drawer">
          <PublishPanel onClose={() => setShowPublish(false)} />
        </div>
      )}
    </div>
  );
}

function NewProjectModal({ onCancel, onCreate }: { onCancel: () => void; onCreate: (name: string, settings: { width: number; height: number }) => void }) {
  const [name, setName] = useState("Untitled");
  const [preset, setPreset] = useState(0);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New project</h2>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label>Format
          <select value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
            {PRESETS.map((p, i) => <option key={i} value={i}>{p.label} ({p.width}×{p.height})</option>)}
          </select>
        </label>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => { const pr = PRESETS[preset] ?? PRESETS[0]!; onCreate(name || "Untitled", { width: pr.width, height: pr.height }); }}>Create</button>
        </div>
      </div>
    </div>
  );
}
