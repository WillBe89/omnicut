import {
  formatTimecode,
  getAsset,
  projectDuration,
  type Clip,
  type Project,
} from "@video-editor/core";

/** Compact one-line description of a clip, including its id for follow-up edits. */
function describeClip(project: Project, clip: Clip): string {
  const end = clip.start + clip.duration;
  const span = `${formatTimecode(clip.start)}→${formatTimecode(end)} (${clip.duration.toFixed(2)}s)`;
  const bits: string[] = [];

  if (clip.text) {
    const preview = clip.text.content.replace(/\n/g, "⏎").slice(0, 40);
    bits.push(`TEXT "${preview}"`);
  } else if (clip.assetId) {
    const asset = getAsset(project, clip.assetId);
    bits.push(asset.name);
    bits.push(`src ${clip.sourceIn.toFixed(2)}–${clip.sourceOut.toFixed(2)}s`);
  }
  if (clip.speed !== 1) bits.push(`${clip.speed}× speed`);
  if (clip.volume !== 1) bits.push(`vol ${clip.volume}`);
  if (clip.opacity !== 1) bits.push(`opacity ${clip.opacity}`);
  if (clip.fadeIn || clip.fadeOut) bits.push(`fade ${clip.fadeIn}/${clip.fadeOut}s`);
  if (clip.audioFadeIn || clip.audioFadeOut) bits.push(`afade ${clip.audioFadeIn}/${clip.audioFadeOut}s`);
  if (clip.transitionOut) bits.push(`→[${clip.transitionOut.type} ${clip.transitionOut.duration}s]`);

  return `    • [${clip.id}] ${span}  ${bits.join("  ·  ")}`;
}

/** Full, AI-friendly snapshot of the timeline. Every id is included so the
 *  agent can target follow-up edits precisely. */
export function formatTimeline(project: Project): string {
  const s = project.settings;
  const lines: string[] = [];
  lines.push(`PROJECT "${project.name}" [${project.id}]`);
  lines.push(
    `  ${s.width}×${s.height} @ ${s.fps}fps · ${(s.sampleRate / 1000).toFixed(1)}kHz · total ${projectDuration(project).toFixed(2)}s`,
  );

  lines.push("  MEDIA:");
  if (project.media.length === 0) lines.push("    (none imported)");
  for (const m of project.media) {
    const dims = m.width ? `${m.width}×${m.height}` : "—";
    lines.push(
      `    - [${m.id}] ${m.name} · ${m.type} · ${m.duration.toFixed(2)}s · ${dims}${m.hasAudio ? " · audio" : ""}`,
    );
  }

  lines.push("  TRACKS (top overlays render over lower ones):");
  for (const track of project.tracks) {
    const flags = [track.muted ? "muted" : "", track.locked ? "locked" : ""].filter(Boolean).join(",");
    lines.push(
      `  ▸ [${track.id}] ${track.name} (${track.type}${flags ? ", " + flags : ""}) — ${track.clips.length} clip(s)`,
    );
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      lines.push(describeClip(project, clip));
    }
  }
  return lines.join("\n");
}

/** Short confirmation line used after mutating tools. */
export function summarize(project: Project): string {
  return `OK. Timeline is now ${projectDuration(project).toFixed(2)}s across ${project.tracks.length} track(s).`;
}
