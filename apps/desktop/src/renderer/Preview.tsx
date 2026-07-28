import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Clip, Project, Track } from "@video-editor/core";
import { getAsset } from "@video-editor/core";
import { toMediaUrl } from "../shared/ipc.js";

interface Props {
  project: Project;
  time: number;
  playing: boolean;
  selectedClipId: string | null;
  onSelect: (id: string) => void;
}

interface ActiveEntry {
  clip: Clip;
  track: Track;
  assetType: "video" | "audio" | "image" | "text";
  path?: string;
}

/** Visual/audio fade multiplier for a clip at time t. */
function fadeFactor(clip: Clip, t: number, kind: "visual" | "audio"): number {
  const fin = kind === "visual" ? clip.fadeIn : clip.audioFadeIn;
  const fout = kind === "visual" ? clip.fadeOut : clip.audioFadeOut;
  const local = t - clip.start;
  const end = clip.duration;
  let f = 1;
  if (fin > 0 && local < fin) f = Math.min(f, local / fin);
  if (fout > 0 && local > end - fout) f = Math.min(f, (end - local) / fout);
  return Math.max(0, Math.min(1, f));
}

export function Preview({ project, time, playing, selectedClipId, onSelect }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageH, setStageH] = useState(0);
  const mediaRefs = useRef<Map<string, HTMLMediaElement>>(new Map());

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageH(el.clientHeight));
    ro.observe(el);
    setStageH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Compute which clips are on-screen/audible at `time`, in composite order
  // (lower tracks first; the first video track is the base layer).
  const active = useMemo<ActiveEntry[]>(() => {
    const entries: ActiveEntry[] = [];
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (time < clip.start || time >= clip.start + clip.duration) continue;
        if (clip.text) {
          entries.push({ clip, track, assetType: "text" });
        } else if (clip.assetId) {
          const asset = getAsset(project, clip.assetId);
          entries.push({ clip, track, assetType: asset.type, path: asset.path });
        }
      }
    }
    return entries;
  }, [project, time]);

  // Sync media element playback/seek/volume every time state changes.
  useEffect(() => {
    for (const { clip, track, assetType } of active) {
      if (assetType !== "video" && assetType !== "audio") continue;
      const el = mediaRefs.current.get(clip.id);
      if (!el) continue;
      const expected = clip.sourceIn + (time - clip.start) * clip.speed;
      el.playbackRate = Math.max(0.0625, Math.min(16, clip.speed));
      const muted = track.muted;
      el.volume = Math.max(0, Math.min(1, clip.volume * fadeFactor(clip, time, "audio")));
      el.muted = muted;
      if (playing) {
        if (Math.abs(el.currentTime - expected) > 0.3) el.currentTime = expected;
        if (el.paused) void el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - expected) > 0.05) el.currentTime = expected;
      }
    }
    // Pause any element whose clip is no longer active.
    const activeIds = new Set(active.map((a) => a.clip.id));
    for (const [id, el] of mediaRefs.current) {
      if (!activeIds.has(id) && !el.paused) el.pause();
    }
  }, [active, time, playing]);

  const setRef = (id: string) => (el: HTMLMediaElement | null) => {
    if (el) mediaRefs.current.set(id, el);
    else mediaRefs.current.delete(id);
  };

  return (
    <div className="stage-wrap">
      <div
        ref={stageRef}
        className="stage"
        style={{ aspectRatio: `${project.settings.width} / ${project.settings.height}`, background: project.settings.background }}
      >
        {active.map(({ clip, assetType, path }) => {
          const selected = clip.id === selectedClipId;
          const isBaseVideo = assetType === "video" && project.tracks.find((t) => t.type === "video")?.clips.some((c) => c.id === clip.id);
          const vis = clip.opacity * fadeFactor(clip, time, "visual");

          if (assetType === "audio") {
            return <audio key={clip.id} ref={setRef(clip.id)} src={toMediaUrl(path!)} preload="auto" />;
          }

          const tf = clip.transform;
          const overlayStyle: React.CSSProperties = isBaseVideo
            ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: vis }
            : {
                position: "absolute",
                left: `${tf.x * 100}%`,
                top: `${tf.y * 100}%`,
                width: `${tf.scale * 100}%`,
                transform: `translate(-50%, -50%) rotate(${tf.rotation}deg)`,
                opacity: vis,
                outline: selected ? "2px solid #4c8bf5" : "none",
              };

          if (assetType === "video") {
            const expected = clip.sourceIn + Math.max(0, time - clip.start) * clip.speed;
            return (
              <video
                key={clip.id}
                ref={setRef(clip.id)}
                src={toMediaUrl(path!)}
                style={overlayStyle}
                preload="auto"
                // Seeking a freshly-loaded, paused <video> forces Chromium to
                // paint the frame (it otherwise stays black until first play).
                onLoadedData={(e) => { if (!playing) e.currentTarget.currentTime = expected; }}
                onClick={() => onSelect(clip.id)}
              />
            );
          }
          if (assetType === "image") {
            return <img key={clip.id} src={toMediaUrl(path!)} style={overlayStyle} onClick={() => onSelect(clip.id)} />;
          }
          // text
          const ts = clip.text!;
          const px = Math.round(ts.fontSize * stageH);
          const strokePx = Math.max(0, Math.round((ts.outlineWidth * stageH) / 1080));
          const textStyle: React.CSSProperties = {
            position: "absolute",
            left: `${tf.x * 100}%`,
            top: `${tf.y * 100}%`,
            transform: `translate(-50%, -50%) rotate(${tf.rotation}deg)`,
            opacity: vis,
            fontSize: px,
            lineHeight: 1.15,
            color: ts.color,
            fontWeight: ts.bold ? 800 : 400,
            fontStyle: ts.italic ? "italic" : "normal",
            textAlign: ts.align,
            whiteSpace: "pre",
            padding: ts.background ? "0.15em 0.4em" : 0,
            background: ts.background ? hexWithAlpha(ts.background, ts.backgroundOpacity) : "transparent",
            WebkitTextStroke: ts.outlineColor && strokePx ? `${strokePx}px ${ts.outlineColor}` : undefined,
            outline: selected ? "2px solid #4c8bf5" : "none",
            cursor: "pointer",
          };
          return (
            <div key={clip.id} style={textStyle} onClick={() => onSelect(clip.id)}>
              {ts.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function hexWithAlpha(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
