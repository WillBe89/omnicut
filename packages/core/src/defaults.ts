import type {
  Clip,
  ProjectSettings,
  TextStyle,
  Transform,
} from "./types.js";

export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000,
  background: "#000000",
  defaultImageDuration: 5,
};

export const DEFAULT_TRANSFORM: Transform = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
};

export const DEFAULT_TEXT_STYLE: Omit<TextStyle, "content"> = {
  fontSize: 0.08,
  color: "#FFFFFF",
  bold: true,
  italic: false,
  align: "center",
  backgroundOpacity: 0.5,
  outlineColor: "#000000",
  outlineWidth: 2,
};

/** Base clip fields shared by every placement. */
export function baseClipFields(): Omit<
  Clip,
  "id" | "assetId" | "start" | "duration" | "sourceIn" | "sourceOut"
> {
  return {
    speed: 1,
    volume: 1,
    audioFadeIn: 0,
    audioFadeOut: 0,
    opacity: 1,
    fadeIn: 0,
    fadeOut: 0,
    transform: { ...DEFAULT_TRANSFORM },
  };
}
