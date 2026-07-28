import { getAsset, type Project, type TransitionType } from "@video-editor/core";
import type { Editor } from "./useEditor.js";

const TRANSITIONS: (TransitionType | "none")[] = [
  "none", "fade", "fadeblack", "fadewhite", "dissolve",
  "wipeleft", "wiperight", "wipeup", "wipedown", "slideleft", "slideright", "circleopen",
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="insp-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Num({ value, step = 0.1, min, max, onChange }: { value: number; step?: number; min?: number; max?: number; onChange: (n: number) => void }) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0}
      step={step}
      min={min}
      max={max}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}

export function Inspector({ project, ed }: { project: Project; ed: Editor }) {
  const clipId = ed.selectedClipId;
  if (!clipId) return <div className="inspector empty">Select a clip to edit its properties.</div>;

  let found: { clip: import("@video-editor/core").Clip; trackType: string } | null = null;
  for (const t of project.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) found = { clip: c, trackType: t.type };
  }
  if (!found) return <div className="inspector empty">Clip not found.</div>;
  const { clip, trackType } = found;
  const asset = clip.assetId ? getAsset(project, clip.assetId) : null;
  const isMainVideo = trackType === "video";

  return (
    <div className="inspector">
      <div className="insp-title">
        {clip.text ? "Text" : asset?.name ?? "Clip"}
        <button className="danger" onClick={() => ed.removeClip(clip.id, false)}>Delete</button>
      </div>

      {clip.text ? (
        <>
          <Row label="Content">
            <textarea value={clip.text.content} rows={2} onChange={(e) => ed.editText(clip.id, { content: e.target.value })} />
          </Row>
          <Row label="Font size (0-1)"><Num value={clip.text.fontSize} step={0.01} min={0.01} max={0.5} onChange={(n) => ed.editText(clip.id, { fontSize: n })} /></Row>
          <Row label="Color"><input type="color" value={clip.text.color} onChange={(e) => ed.editText(clip.id, { color: e.target.value })} /></Row>
          <Row label="Bold"><input type="checkbox" checked={clip.text.bold} onChange={(e) => ed.editText(clip.id, { bold: e.target.checked })} /></Row>
          <Row label="Italic"><input type="checkbox" checked={clip.text.italic} onChange={(e) => ed.editText(clip.id, { italic: e.target.checked })} /></Row>
          <Row label="Align">
            <select value={clip.text.align} onChange={(e) => ed.editText(clip.id, { align: e.target.value as "left" | "center" | "right" })}>
              <option value="left">left</option><option value="center">center</option><option value="right">right</option>
            </select>
          </Row>
          <Row label="Box color"><input type="color" value={clip.text.background ?? "#000000"} onChange={(e) => ed.editText(clip.id, { background: e.target.value })} /></Row>
          <Row label="Box opacity"><Num value={clip.text.backgroundOpacity} step={0.05} min={0} max={1} onChange={(n) => ed.editText(clip.id, { backgroundOpacity: n })} /></Row>
        </>
      ) : (
        <>
          {asset && (asset.type === "video" || asset.type === "audio") && (
            <>
              <Row label="Trim in (s)"><Num value={clip.sourceIn} onChange={(n) => ed.trim(clip.id, n, undefined)} /></Row>
              <Row label="Trim out (s)"><Num value={clip.sourceOut} onChange={(n) => ed.trim(clip.id, undefined, n)} /></Row>
              <Row label="Speed"><Num value={clip.speed} step={0.1} min={0.1} max={8} onChange={(n) => ed.setSpeed(clip.id, n || 1)} /></Row>
            </>
          )}
        </>
      )}

      {trackType !== "audio" && (
        <>
          <Row label="Opacity"><Num value={clip.opacity} step={0.05} min={0} max={1} onChange={(n) => ed.setOpacity(clip.id, n)} /></Row>
          <Row label="Fade in (s)"><Num value={clip.fadeIn} step={0.1} min={0} onChange={(n) => ed.setFades(clip.id, { fadeIn: n })} /></Row>
          <Row label="Fade out (s)"><Num value={clip.fadeOut} step={0.1} min={0} onChange={(n) => ed.setFades(clip.id, { fadeOut: n })} /></Row>
        </>
      )}

      {(trackType === "overlay") && !clip.text && (
        <>
          <Row label="Pos X (0-1)"><Num value={clip.transform.x} step={0.02} min={0} max={1} onChange={(n) => ed.setTransform(clip.id, { x: n })} /></Row>
          <Row label="Pos Y (0-1)"><Num value={clip.transform.y} step={0.02} min={0} max={1} onChange={(n) => ed.setTransform(clip.id, { y: n })} /></Row>
          <Row label="Scale"><Num value={clip.transform.scale} step={0.05} min={0.05} max={2} onChange={(n) => ed.setTransform(clip.id, { scale: n })} /></Row>
        </>
      )}
      {trackType === "overlay" && clip.text && (
        <>
          <Row label="Pos X (0-1)"><Num value={clip.transform.x} step={0.02} min={0} max={1} onChange={(n) => ed.setTransform(clip.id, { x: n })} /></Row>
          <Row label="Pos Y (0-1)"><Num value={clip.transform.y} step={0.02} min={0} max={1} onChange={(n) => ed.setTransform(clip.id, { y: n })} /></Row>
        </>
      )}

      {(asset && asset.hasAudio) && (
        <>
          <Row label="Volume"><Num value={clip.volume} step={0.05} min={0} max={2} onChange={(n) => ed.setVolume(clip.id, n)} /></Row>
          <Row label="Audio fade in"><Num value={clip.audioFadeIn} step={0.1} min={0} onChange={(n) => ed.setAudioFades(clip.id, { fadeIn: n })} /></Row>
          <Row label="Audio fade out"><Num value={clip.audioFadeOut} step={0.1} min={0} onChange={(n) => ed.setAudioFades(clip.id, { fadeOut: n })} /></Row>
        </>
      )}

      {isMainVideo && (
        <Row label="Transition out">
          <select
            value={clip.transitionOut?.type ?? "none"}
            onChange={(e) => {
              const v = e.target.value;
              ed.setClipTransition(clip.id, v === "none" ? null : { type: v as TransitionType, duration: clip.transitionOut?.duration ?? 0.5 });
            }}
          >
            {TRANSITIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Row>
      )}
      {isMainVideo && clip.transitionOut && (
        <Row label="Transition dur"><Num value={clip.transitionOut.duration} step={0.1} min={0.1} max={3} onChange={(n) => ed.setClipTransition(clip.id, { type: clip.transitionOut!.type, duration: n })} /></Row>
      )}
    </div>
  );
}
