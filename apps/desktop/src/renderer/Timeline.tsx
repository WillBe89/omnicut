import { useRef, useState } from "react";
import { formatTimecode, getAsset, projectDuration, type Clip, type Project } from "@video-editor/core";

interface Props {
  project: Project;
  time: number;
  selectedClipId: string | null;
  onSeek: (t: number) => void;
  onSelect: (id: string | null) => void;
  onMoveClip: (clipId: string, start: number, trackId?: string) => void;
}

const PX_PER_SEC = 90;
const TRACK_H = 56;

function clipLabel(project: Project, clip: Clip): string {
  if (clip.text) return `T  ${clip.text.content.replace(/\n/g, " ")}`;
  if (clip.assetId) return getAsset(project, clip.assetId).name;
  return "clip";
}

export function Timeline({ project, time, selectedClipId, onSeek, onSelect, onMoveClip }: Props) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ clipId: string; startX: number; origStart: number; preview: number } | null>(null);

  const total = Math.max(projectDuration(project), 10);
  const width = total * PX_PER_SEC + 200;

  const seekFromEvent = (e: React.MouseEvent) => {
    const lane = laneRef.current;
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    const x = e.clientX - rect.left + lane.scrollLeft;
    onSeek(Math.max(0, x / PX_PER_SEC));
  };

  const onClipPointerDown = (e: React.PointerEvent, clip: Clip) => {
    e.stopPropagation();
    onSelect(clip.id);
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ clipId: clip.id, startX: e.clientX, origStart: clip.start, preview: clip.start });
  };
  const onClipPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const preview = Math.max(0, drag.origStart + dx / PX_PER_SEC);
    setDrag({ ...drag, preview });
  };
  const onClipPointerUp = () => {
    if (!drag) return;
    if (Math.abs(drag.preview - drag.origStart) > 0.01) {
      onMoveClip(drag.clipId, Math.round(drag.preview * 100) / 100);
    }
    setDrag(null);
  };

  const seconds = Math.ceil(total);
  const tickStep = total > 60 ? 10 : total > 20 ? 5 : 1;

  return (
    <div className="timeline">
      <div className="timeline-scroll" ref={laneRef}>
        <div style={{ width, position: "relative" }}>
          {/* Ruler */}
          <div className="ruler" onClick={seekFromEvent}>
            {Array.from({ length: seconds + 1 }).map((_, s) =>
              s % tickStep === 0 ? (
                <div key={s} className="tick" style={{ left: s * PX_PER_SEC }}>
                  <span>{formatTimecode(s)}</span>
                </div>
              ) : null,
            )}
          </div>

          {/* Tracks */}
          <div onClick={() => onSelect(null)}>
            {project.tracks.map((track) => (
              <div key={track.id} className={`track track-${track.type}`} style={{ height: TRACK_H }}>
                <div className="track-label">{track.name}</div>
                {[...track.clips]
                  .sort((a, b) => a.start - b.start)
                  .map((clip) => {
                    const start = drag?.clipId === clip.id ? drag.preview : clip.start;
                    return (
                      <div
                        key={clip.id}
                        className={`clip ${clip.id === selectedClipId ? "selected" : ""}`}
                        style={{ left: start * PX_PER_SEC, width: Math.max(8, clip.duration * PX_PER_SEC) }}
                        onPointerDown={(e) => onClipPointerDown(e, clip)}
                        onPointerMove={onClipPointerMove}
                        onPointerUp={onClipPointerUp}
                        title={clipLabel(project, clip)}
                      >
                        <span className="clip-label">{clipLabel(project, clip)}</span>
                        {clip.transitionOut && <span className="clip-trans">⇥</span>}
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>

          {/* Playhead */}
          <div className="playhead" style={{ left: time * PX_PER_SEC }} />
        </div>
      </div>
    </div>
  );
}
