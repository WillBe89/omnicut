/**
 * The timeline data model — the single source of truth for an edit.
 *
 * Everything here is plain JSON-serializable data with NO platform dependencies,
 * so it ports to web/mobile untouched. Times are ALWAYS in seconds (floating point).
 * Positions/sizes for overlays are normalized 0..1 relative to the project frame,
 * so the same edit renders identically at any output resolution.
 */

export type MediaType = "video" | "audio" | "image";

export interface MediaAsset {
  id: string;
  /** Absolute path on disk (desktop) or URI (future mobile/web). */
  path: string;
  /** Display name, defaults to the file's basename. */
  name: string;
  type: MediaType;
  /** Source duration in seconds. Images use the project default still duration. */
  duration: number;
  /** Native pixel dimensions (undefined for pure audio). */
  width?: number;
  height?: number;
  /** Source frame rate (video only). */
  fps?: number;
  /** Whether the source carries an audio stream. */
  hasAudio: boolean;
}

export type TrackType = "video" | "audio" | "overlay";

export interface Track {
  id: string;
  type: TrackType;
  /** Clips are kept sorted by `start`. */
  clips: Clip[];
  muted: boolean;
  locked: boolean;
  /** Human label, e.g. "Main", "Music", "Captions". */
  name: string;
}

/** Transition applied at the boundary INTO the next clip on the same track. */
export interface Transition {
  type: TransitionType;
  /** Overlap duration in seconds. */
  duration: number;
}

export type TransitionType =
  | "fade" // crossfade through black is `fadeblack`; `fade` = dissolve
  | "fadeblack"
  | "fadewhite"
  | "wipeleft"
  | "wiperight"
  | "wipeup"
  | "wipedown"
  | "slideleft"
  | "slideright"
  | "circleopen"
  | "dissolve";

export interface Transform {
  /** Normalized center position 0..1 (0.5 = centered). */
  x: number;
  y: number;
  /** Scale multiplier relative to a "fit" baseline (1 = fit frame). */
  scale: number;
  /** Rotation in degrees, clockwise. */
  rotation: number;
}

export type TextAlign = "left" | "center" | "right";

export interface TextStyle {
  content: string;
  fontSize: number; // as a fraction of frame height (0.05 = 5% of height)
  color: string; // hex e.g. "#FFFFFF"
  fontFamily?: string;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** Optional solid background box behind the text. */
  background?: string; // hex or undefined
  /** Box opacity 0..1 when background is set. */
  backgroundOpacity: number;
  /** Optional outline. */
  outlineColor?: string;
  outlineWidth: number; // px at 1080p, scaled to frame
}

/**
 * A clip is one segment placed on a track.
 * - video/audio tracks: `assetId` references a MediaAsset, and `sourceIn/sourceOut`
 *   define the trimmed portion of the source used.
 * - overlay tracks: either an image/video asset OR a `text` element (assetId null).
 */
export interface Clip {
  id: string;
  /** Null only for text overlays. */
  assetId: string | null;

  /** Timeline placement. */
  start: number; // seconds on the timeline where this clip begins
  duration: number; // seconds occupied on the timeline (after speed applied)

  /** Source trim (video/audio/image-with-motion). Ignored for text. */
  sourceIn: number; // in-point within the source media (seconds)
  sourceOut: number; // out-point within the source media (seconds)

  /** Playback speed multiplier (1 = normal, 2 = 2x faster, 0.5 = slow-mo). */
  speed: number;

  /** Audio gain multiplier (1 = unchanged). Applies to the clip's own audio. */
  volume: number;
  /** Fade the clip's audio in/out, seconds. */
  audioFadeIn: number;
  audioFadeOut: number;

  /** Visual opacity 0..1 (overlay/video). */
  opacity: number;
  /** Visual fades (video/overlay), seconds. */
  fadeIn: number;
  fadeOut: number;

  /** Position/scale/rotation for overlay & PiP clips. */
  transform: Transform;

  /** Present only for text overlay clips. */
  text?: TextStyle;

  /** Transition INTO the following clip on this track. */
  transitionOut?: Transition;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  /** Audio sample rate for the render. */
  sampleRate: number;
  /** Background color behind everything (hex). */
  background: string;
  /** Default duration (seconds) when placing a still image. */
  defaultImageDuration: number;
}

export interface Project {
  /** Schema version for forward migration. */
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  settings: ProjectSettings;
  media: MediaAsset[];
  /** Ordered; overlay/video tracks composite bottom→top, audio tracks mix. */
  tracks: Track[];
}
