/**
 * Edit operations. Each takes a Project and returns a NEW project (the input is
 * never mutated), so callers can keep an undo history for free. Every op keeps
 * the invariants: clips sorted by start, durations consistent with trims/speed,
 * updatedAt bumped.
 */
import {
  DEFAULT_SETTINGS,
  DEFAULT_TEXT_STYLE,
  baseClipFields,
} from "./defaults.js";
import { makeId } from "./ids.js";
import {
  cloneProject,
  getAsset,
  getClip,
  getTrack,
  isTimeBased,
  projectDuration,
  sortClips,
} from "./select.js";
import { clamp, snap } from "./time.js";
import type {
  Clip,
  MediaAsset,
  Project,
  TextStyle,
  Track,
  TrackType,
  Transform,
  Transition,
} from "./types.js";

function touch(project: Project): Project {
  project.updatedAt = new Date().toISOString();
  return project;
}

/** Drop keys whose value is `undefined` so a partial patch never clobbers a
 *  default/existing value with `undefined` when spread. */
function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Recompute a media clip's timeline duration from its trim + speed. */
function syncDuration(project: Project, clip: Clip): void {
  if (isTimeBased(project, clip)) {
    const sourceSpan = Math.max(0, clip.sourceOut - clip.sourceIn);
    clip.duration = snap(sourceSpan / clip.speed);
  }
  // Images/text keep an explicit duration set by the caller.
}

// ─────────────────────────────────────────────────────────── project / media

export function createProject(
  name: string,
  settings: Partial<Project["settings"]> = {},
): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: makeId("proj"),
    name,
    createdAt: now,
    updatedAt: now,
    settings: { ...DEFAULT_SETTINGS, ...definedOnly(settings) },
    media: [],
    tracks: [
      { id: makeId("trk"), type: "video", clips: [], muted: false, locked: false, name: "Main" },
      { id: makeId("trk"), type: "overlay", clips: [], muted: false, locked: false, name: "Overlay" },
      { id: makeId("trk"), type: "audio", clips: [], muted: false, locked: false, name: "Music" },
    ],
  };
}

export function addMedia(
  project: Project,
  asset: Omit<MediaAsset, "id">,
): { project: Project; assetId: string } {
  const next = cloneProject(project);
  const id = makeId("media");
  next.media.push({ ...asset, id });
  return { project: touch(next), assetId: id };
}

export function removeMedia(project: Project, assetId: string): Project {
  const next = cloneProject(project);
  getAsset(next, assetId); // validate
  next.media = next.media.filter((m) => m.id !== assetId);
  for (const track of next.tracks) {
    track.clips = track.clips.filter((c) => c.assetId !== assetId);
  }
  return touch(next);
}

// ──────────────────────────────────────────────────────────────────── tracks

export function addTrack(
  project: Project,
  type: TrackType,
  name?: string,
): { project: Project; trackId: string } {
  const next = cloneProject(project);
  const id = makeId("trk");
  next.tracks.push({
    id,
    type,
    clips: [],
    muted: false,
    locked: false,
    name: name ?? type,
  });
  return { project: touch(next), trackId: id };
}

export function removeTrack(project: Project, trackId: string): Project {
  const next = cloneProject(project);
  getTrack(next, trackId);
  next.tracks = next.tracks.filter((t) => t.id !== trackId);
  return touch(next);
}

export function setTrackMuted(project: Project, trackId: string, muted: boolean): Project {
  const next = cloneProject(project);
  getTrack(next, trackId).muted = muted;
  return touch(next);
}

// ───────────────────────────────────────────────────────────────────── clips

export interface AddClipParams {
  trackId: string;
  assetId: string;
  /** Timeline start; when omitted the clip is appended after the last clip. */
  start?: number;
  /** Source trim; defaults to the whole asset. */
  sourceIn?: number;
  sourceOut?: number;
  /** For images: on-timeline duration (defaults to project default). */
  duration?: number;
  speed?: number;
  volume?: number;
}

export function addClip(
  project: Project,
  params: AddClipParams,
): { project: Project; clipId: string } {
  const next = cloneProject(project);
  const track = getTrack(next, params.trackId);
  const asset = getAsset(next, params.assetId);
  const id = makeId("clip");

  const speed = params.speed ?? 1;
  const timeBased = asset.type === "video" || asset.type === "audio";

  const sourceIn = clamp(params.sourceIn ?? 0, 0, asset.duration);
  const sourceOut = clamp(
    params.sourceOut ?? asset.duration,
    sourceIn,
    asset.duration,
  );

  const start =
    params.start ??
    (track.clips.length
      ? Math.max(...track.clips.map((c) => c.start + c.duration))
      : 0);

  let duration: number;
  if (timeBased) {
    duration = snap((sourceOut - sourceIn) / speed);
  } else {
    duration = params.duration ?? next.settings.defaultImageDuration;
  }

  const clip: Clip = {
    id,
    assetId: params.assetId,
    start: snap(start),
    duration,
    sourceIn: snap(sourceIn),
    sourceOut: snap(sourceOut),
    ...baseClipFields(),
    speed,
    volume: params.volume ?? 1,
  };

  track.clips.push(clip);
  sortClips(track);
  return { project: touch(next), clipId: id };
}

/**
 * Trim a clip by moving its in/out points. Positive `startDelta` moves the
 * in-point later (trims the head); `endDelta` moves the out-point. When
 * `rippleHead` is true, the timeline start shifts so the clip stays put.
 */
export interface TrimClipParams {
  clipId: string;
  /** New absolute source in-point (seconds). */
  sourceIn?: number;
  /** New absolute source out-point (seconds). */
  sourceOut?: number;
}

export function trimClip(project: Project, params: TrimClipParams): Project {
  const next = cloneProject(project);
  const { track, clip } = getClip(next, params.clipId);

  if (clip.assetId) {
    const asset = getAsset(next, clip.assetId);
    if (params.sourceIn !== undefined) {
      clip.sourceIn = clamp(params.sourceIn, 0, asset.duration);
    }
    if (params.sourceOut !== undefined) {
      clip.sourceOut = clamp(params.sourceOut, clip.sourceIn, asset.duration);
    }
  }
  syncDuration(next, clip);
  sortClips(track);
  return touch(next);
}

/**
 * Split a clip at an absolute timeline time, producing two adjacent clips.
 * Returns the ids of the left and right halves.
 */
export function splitClip(
  project: Project,
  clipId: string,
  atTime: number,
): { project: Project; leftId: string; rightId: string } {
  const next = cloneProject(project);
  const { track, clip } = getClip(next, clipId);

  const clipEnd = clip.start + clip.duration;
  if (atTime <= clip.start + 1e-6 || atTime >= clipEnd - 1e-6) {
    throw new Error(
      `Split time ${atTime}s is outside clip bounds (${clip.start}..${clipEnd}s)`,
    );
  }

  const offsetOnTimeline = atTime - clip.start;
  // Map the timeline offset back into source time (accounting for speed).
  const sourceSplit = clip.sourceIn + offsetOnTimeline * clip.speed;

  const rightId = makeId("clip");
  const right: Clip = structuredClone(clip);
  right.id = rightId;
  right.start = snap(atTime);
  right.sourceIn = snap(sourceSplit);
  right.duration = snap(clipEnd - atTime);
  // The transition (into the following clip) belongs to the right half only.
  right.fadeIn = 0;
  right.audioFadeIn = 0;

  // Left half keeps its head; drop any transitionOut and tail fades.
  clip.sourceOut = snap(sourceSplit);
  clip.duration = snap(offsetOnTimeline);
  clip.fadeOut = 0;
  clip.audioFadeOut = 0;
  delete clip.transitionOut;

  track.clips.push(right);
  sortClips(track);
  return { project: touch(next), leftId: clip.id, rightId };
}

/** Move a clip to a new start time and/or a different track of the same kind. */
export function moveClip(
  project: Project,
  clipId: string,
  newStart: number,
  newTrackId?: string,
): Project {
  const next = cloneProject(project);
  const { track, clip, index } = getClip(next, clipId);

  clip.start = snap(Math.max(0, newStart));

  if (newTrackId && newTrackId !== track.id) {
    const target = getTrack(next, newTrackId);
    track.clips.splice(index, 1);
    target.clips.push(clip);
    sortClips(target);
  }
  sortClips(track);
  return touch(next);
}

export function deleteClip(project: Project, clipId: string): Project {
  const next = cloneProject(project);
  const { track } = getClip(next, clipId);
  track.clips = track.clips.filter((c) => c.id !== clipId);
  return touch(next);
}

/**
 * Remove a clip and close the gap: every later clip on the same track shifts
 * left by the removed clip's duration (ripple delete).
 */
export function rippleDelete(project: Project, clipId: string): Project {
  const next = cloneProject(project);
  const { track, clip } = getClip(next, clipId);
  const gap = clip.duration;
  const removedStart = clip.start;
  track.clips = track.clips.filter((c) => c.id !== clipId);
  for (const c of track.clips) {
    if (c.start >= removedStart) c.start = snap(c.start - gap);
  }
  return touch(next);
}

/** Remove all gaps on a track so clips play back-to-back from `start`. */
export function compactTrack(project: Project, trackId: string, start = 0): Project {
  const next = cloneProject(project);
  const track = getTrack(next, trackId);
  sortClips(track);
  let cursor = start;
  for (const c of track.clips) {
    c.start = snap(cursor);
    cursor += c.duration;
  }
  return touch(next);
}

// ────────────────────────────────────────────────────────────────── effects

export function setClipSpeed(project: Project, clipId: string, speed: number): Project {
  if (speed <= 0) throw new Error("Speed must be > 0");
  const next = cloneProject(project);
  const { track, clip } = getClip(next, clipId);
  clip.speed = speed;
  syncDuration(next, clip);
  sortClips(track);
  return touch(next);
}

export function setClipVolume(project: Project, clipId: string, volume: number): Project {
  const next = cloneProject(project);
  getClip(next, clipId).clip.volume = Math.max(0, volume);
  return touch(next);
}

export function setClipOpacity(project: Project, clipId: string, opacity: number): Project {
  const next = cloneProject(project);
  getClip(next, clipId).clip.opacity = clamp(opacity, 0, 1);
  return touch(next);
}

export function setClipFades(
  project: Project,
  clipId: string,
  fades: { fadeIn?: number; fadeOut?: number },
): Project {
  const next = cloneProject(project);
  const { clip } = getClip(next, clipId);
  if (fades.fadeIn !== undefined) clip.fadeIn = Math.max(0, fades.fadeIn);
  if (fades.fadeOut !== undefined) clip.fadeOut = Math.max(0, fades.fadeOut);
  return touch(next);
}

export function setClipAudioFades(
  project: Project,
  clipId: string,
  fades: { fadeIn?: number; fadeOut?: number },
): Project {
  const next = cloneProject(project);
  const { clip } = getClip(next, clipId);
  if (fades.fadeIn !== undefined) clip.audioFadeIn = Math.max(0, fades.fadeIn);
  if (fades.fadeOut !== undefined) clip.audioFadeOut = Math.max(0, fades.fadeOut);
  return touch(next);
}

export function setClipTransform(
  project: Project,
  clipId: string,
  transform: Partial<Transform>,
): Project {
  const next = cloneProject(project);
  const { clip } = getClip(next, clipId);
  clip.transform = { ...clip.transform, ...definedOnly(transform) };
  return touch(next);
}

/** Set (or clear, when transition is null) the transition into the next clip. */
export function setTransition(
  project: Project,
  clipId: string,
  transition: Transition | null,
): Project {
  const next = cloneProject(project);
  const { clip } = getClip(next, clipId);
  if (transition === null) delete clip.transitionOut;
  else clip.transitionOut = { ...transition, duration: Math.max(0, transition.duration) };
  return touch(next);
}

// ─────────────────────────────────────────────────────────────────────── text

export interface AddTextParams {
  trackId: string;
  content: string;
  start: number;
  duration: number;
  style?: Partial<Omit<TextStyle, "content">>;
  transform?: Partial<Transform>;
}

export function addText(
  project: Project,
  params: AddTextParams,
): { project: Project; clipId: string } {
  const next = cloneProject(project);
  const track = getTrack(next, params.trackId);
  const id = makeId("clip");

  const clip: Clip = {
    id,
    assetId: null,
    start: snap(params.start),
    duration: snap(params.duration),
    sourceIn: 0,
    sourceOut: 0,
    ...baseClipFields(),
    text: { ...DEFAULT_TEXT_STYLE, ...params.style, content: params.content },
  };
  if (params.transform) {
    clip.transform = { ...clip.transform, ...params.transform };
  }
  track.clips.push(clip);
  sortClips(track);
  return { project: touch(next), clipId: id };
}

export function updateText(
  project: Project,
  clipId: string,
  patch: Partial<TextStyle>,
): Project {
  const next = cloneProject(project);
  const { clip } = getClip(next, clipId);
  if (!clip.text) throw new Error(`Clip ${clipId} is not a text clip`);
  clip.text = { ...clip.text, ...definedOnly(patch) };
  return touch(next);
}

export { projectDuration };
