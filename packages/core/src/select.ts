import type { Clip, MediaAsset, Project, Track } from "./types.js";

/** Deep clone a project (structuredClone is available in Node 17+/modern browsers). */
export function cloneProject(project: Project): Project {
  return structuredClone(project);
}

export function getTrack(project: Project, trackId: string): Track {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track not found: ${trackId}`);
  return track;
}

export function getAsset(project: Project, assetId: string): MediaAsset {
  const asset = project.media.find((m) => m.id === assetId);
  if (!asset) throw new Error(`Media asset not found: ${assetId}`);
  return asset;
}

export interface ClipLocation {
  track: Track;
  clip: Clip;
  index: number;
}

export function getClip(project: Project, clipId: string): ClipLocation {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  throw new Error(`Clip not found: ${clipId}`);
}

/** Keep a track's clips ordered by timeline start. */
export function sortClips(track: Track): void {
  track.clips.sort((a, b) => a.start - b.start);
}

/** The end time (seconds) of the last clip across all tracks. */
export function projectDuration(project: Project): number {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.start + clip.duration);
    }
  }
  return end;
}

/** True when the clip's source is time-based (video/audio) vs a still/text. */
export function isTimeBased(project: Project, clip: Clip): boolean {
  if (!clip.assetId) return false; // text
  const asset = getAsset(project, clip.assetId);
  return asset.type === "video" || asset.type === "audio";
}
