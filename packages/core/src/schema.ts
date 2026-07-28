import { z } from "zod";
import type { Project } from "./types.js";

const transformSchema = z.object({
  x: z.number(),
  y: z.number(),
  scale: z.number(),
  rotation: z.number(),
});

const textStyleSchema = z.object({
  content: z.string(),
  fontSize: z.number(),
  color: z.string(),
  fontFamily: z.string().optional(),
  bold: z.boolean(),
  italic: z.boolean(),
  align: z.enum(["left", "center", "right"]),
  background: z.string().optional(),
  backgroundOpacity: z.number(),
  outlineColor: z.string().optional(),
  outlineWidth: z.number(),
});

const transitionSchema = z.object({
  type: z.enum([
    "fade",
    "fadeblack",
    "fadewhite",
    "wipeleft",
    "wiperight",
    "wipeup",
    "wipedown",
    "slideleft",
    "slideright",
    "circleopen",
    "dissolve",
  ]),
  duration: z.number(),
});

const clipSchema = z.object({
  id: z.string(),
  assetId: z.string().nullable(),
  start: z.number(),
  duration: z.number(),
  sourceIn: z.number(),
  sourceOut: z.number(),
  speed: z.number(),
  volume: z.number(),
  audioFadeIn: z.number(),
  audioFadeOut: z.number(),
  opacity: z.number(),
  fadeIn: z.number(),
  fadeOut: z.number(),
  transform: transformSchema,
  text: textStyleSchema.optional(),
  transitionOut: transitionSchema.optional(),
});

const trackSchema = z.object({
  id: z.string(),
  type: z.enum(["video", "audio", "overlay"]),
  clips: z.array(clipSchema),
  muted: z.boolean(),
  locked: z.boolean(),
  name: z.string(),
});

const mediaSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  type: z.enum(["video", "audio", "image"]),
  duration: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  hasAudio: z.boolean(),
});

export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  settings: z.object({
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    sampleRate: z.number(),
    background: z.string(),
    defaultImageDuration: z.number(),
  }),
  media: z.array(mediaSchema),
  tracks: z.array(trackSchema),
});

export function parseProject(data: unknown): Project {
  return projectSchema.parse(data) as Project;
}
