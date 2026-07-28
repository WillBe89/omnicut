import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import {
  addClip, addMedia, addText, addTrack, compactTrack, createProject,
  deleteClip, moveClip, removeTrack, rippleDelete, setClipAudioFades,
  setClipFades, setClipOpacity, setClipSpeed, setClipTransform, setClipVolume,
  setTrackMuted, setTransition, splitClip, trimClip, updateText,
} from "@video-editor/core";
import { probeMedia, renderProject, renderMusicVideo, renderMusicVideoReactive } from "@video-editor/engine-ffmpeg";
import { ProjectStore } from "./store.js";
import { formatTimeline } from "./format.js";

const TRANSITION_TYPES = [
  "fade", "fadeblack", "fadewhite", "wipeleft", "wiperight", "wipeup",
  "wipedown", "slideleft", "slideright", "circleopen", "dissolve",
] as const;

export function createServer(store: ProjectStore): McpServer {
  const server = new McpServer(
    { name: "video-editor", version: "0.1.0" },
    {
      instructions:
        "Deterministic video editor. You compose an edit by mutating a timeline " +
        "(tracks → clips); FFmpeg renders the pixels. This is NOT generative video — " +
        "you assemble real footage. Workflow: create_project → import_media → add clips " +
        "to tracks → refine (trim/split/speed/transitions/text/audio) → render. " +
        "Track 1 (video) is the main sequence; overlay tracks composite on top; audio " +
        "tracks are for music/voiceover. Every tool returns the full timeline with ids — " +
        "read it to plan your next edit. Times are in seconds.",
    },
  );

  /** Render a tool response as the full, id-annotated timeline. */
  const timeline = (note?: string) => ({
    content: [
      { type: "text" as const, text: (note ? note + "\n\n" : "") + formatTimeline(store.current) },
    ],
  });
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  // ─────────────────────────────────────────────────────────────── session

  server.registerTool(
    "create_project",
    {
      description: "Create a new empty project (with a Main video track, an Overlay track, and a Music audio track) and make it active. Common sizes: 1920×1080 landscape, 1080×1920 vertical/Shorts, 1080×1080 square.",
      inputSchema: {
        name: z.string().describe("Project name."),
        width: z.number().int().positive().optional().describe("Frame width in px (default 1920)."),
        height: z.number().int().positive().optional().describe("Frame height in px (default 1080)."),
        fps: z.number().positive().optional().describe("Frames per second (default 30)."),
        background: z.string().optional().describe("Background hex color, e.g. #000000."),
      },
    },
    async ({ name, width, height, fps, background }) => {
      const project = createProject(name, { width, height, fps, background });
      store.set(project);
      return timeline(`Created project "${name}".`);
    },
  );

  server.registerTool(
    "open_project",
    {
      description: "Load a saved project .json from disk and make it active.",
      inputSchema: { path: z.string().describe("Absolute path to a project .json file.") },
    },
    async ({ path }) => {
      store.load(path);
      return timeline(`Opened project from ${path}.`);
    },
  );

  server.registerTool(
    "save_project",
    {
      description: "Save the active project to disk as JSON (also autosaved after every edit).",
      inputSchema: { path: z.string().optional().describe("Target path; defaults to the project store.") },
    },
    async ({ path }) => text(`Saved to ${store.save(path)}`),
  );

  server.registerTool(
    "list_projects",
    { description: "List saved project files in the project store.", inputSchema: {} },
    async () => {
      const files = readdirSync(store.projectsDir).filter((f) => f.endsWith(".json"));
      return text(files.length ? files.map((f) => join(store.projectsDir, f)).join("\n") : "(no saved projects)");
    },
  );

  server.registerTool(
    "get_timeline",
    { description: "Show the full current timeline: media library, tracks, clips, effects — with all ids. Read this to plan edits.", inputSchema: {} },
    async () => timeline(),
  );

  server.registerTool(
    "undo",
    { description: "Undo the last edit.", inputSchema: {} },
    async () => (store.undo() ? timeline("Undone.") : text("Nothing to undo.")),
  );

  server.registerTool(
    "redo",
    { description: "Redo the last undone edit.", inputSchema: {} },
    async () => (store.redo() ? timeline("Redone.") : text("Nothing to redo.")),
  );

  // ───────────────────────────────────────────────────────────────── media

  server.registerTool(
    "import_media",
    {
      description: "Probe a video/audio/image file and add it to the project's media library. Returns its assetId (and duration/resolution) for use with add_clip. Does NOT place it on the timeline.",
      inputSchema: { path: z.string().describe("Absolute path to a media file (mp4/mov/mp3/wav/png/jpg…).") },
    },
    async ({ path }) => {
      const meta = await probeMedia(path);
      const { project, assetId } = addMedia(store.current, meta);
      store.update(() => project);
      return timeline(
        `Imported ${meta.name} as [${assetId}] (${meta.type}, ${meta.duration.toFixed(2)}s${meta.width ? `, ${meta.width}×${meta.height}` : ""}${meta.hasAudio ? ", has audio" : ""}).`,
      );
    },
  );

  // ──────────────────────────────────────────────────────────────── tracks

  server.registerTool(
    "add_track",
    {
      description: "Add a new track. 'video' = full-frame sequence, 'overlay' = composited layer (text/PiP/images), 'audio' = music/voiceover.",
      inputSchema: {
        type: z.enum(["video", "audio", "overlay"]),
        name: z.string().optional(),
      },
    },
    async ({ type, name }) => {
      const { project, trackId } = addTrack(store.current, type, name);
      store.update(() => project);
      return timeline(`Added ${type} track [${trackId}].`);
    },
  );

  server.registerTool(
    "set_track_muted",
    {
      description: "Mute or unmute a track's audio contribution.",
      inputSchema: { trackId: z.string(), muted: z.boolean() },
    },
    async ({ trackId, muted }) => {
      store.update((p) => setTrackMuted(p, trackId, muted));
      return timeline(`Track ${trackId} ${muted ? "muted" : "unmuted"}.`);
    },
  );

  server.registerTool(
    "remove_track",
    { description: "Delete a track and all its clips.", inputSchema: { trackId: z.string() } },
    async ({ trackId }) => {
      store.update((p) => removeTrack(p, trackId));
      return timeline(`Removed track ${trackId}.`);
    },
  );

  // ───────────────────────────────────────────────────────────────── clips

  server.registerTool(
    "add_clip",
    {
      description: "Place a media asset on a track. Omit `start` to append after the last clip on that track. Omit source in/out to use the whole asset. For images, `duration` sets on-screen time. Returns the new clipId.",
      inputSchema: {
        trackId: z.string(),
        assetId: z.string(),
        start: z.number().min(0).optional().describe("Timeline start (s). Omit to append."),
        sourceIn: z.number().min(0).optional().describe("In-point within the source (s)."),
        sourceOut: z.number().min(0).optional().describe("Out-point within the source (s)."),
        duration: z.number().positive().optional().describe("On-timeline duration for images (s)."),
        speed: z.number().positive().optional().describe("Playback speed (1=normal, 2=2×, 0.5=slow-mo)."),
        volume: z.number().min(0).optional(),
      },
    },
    async (args) => {
      const { project, clipId } = addClip(store.current, args);
      store.update(() => project);
      return timeline(`Added clip [${clipId}] to track ${args.trackId}.`);
    },
  );

  server.registerTool(
    "trim_clip",
    {
      description: "Adjust a clip's source in/out points (trims the head/tail). Timeline duration recomputes automatically from the trim and speed.",
      inputSchema: {
        clipId: z.string(),
        sourceIn: z.number().min(0).optional(),
        sourceOut: z.number().min(0).optional(),
      },
    },
    async ({ clipId, sourceIn, sourceOut }) => {
      store.update((p) => trimClip(p, { clipId, sourceIn, sourceOut }));
      return timeline(`Trimmed clip ${clipId}.`);
    },
  );

  server.registerTool(
    "split_clip",
    {
      description: "Split a clip into two at an absolute timeline time. Returns both halves' ids.",
      inputSchema: { clipId: z.string(), atTime: z.number().positive().describe("Absolute timeline time (s) to cut at.") },
    },
    async ({ clipId, atTime }) => {
      const { project, leftId, rightId } = splitClip(store.current, clipId, atTime);
      store.update(() => project);
      return timeline(`Split ${clipId} → left [${leftId}], right [${rightId}].`);
    },
  );

  server.registerTool(
    "move_clip",
    {
      description: "Move a clip to a new start time and optionally to another track (of a compatible type).",
      inputSchema: { clipId: z.string(), newStart: z.number().min(0), newTrackId: z.string().optional() },
    },
    async ({ clipId, newStart, newTrackId }) => {
      store.update((p) => moveClip(p, clipId, newStart, newTrackId));
      return timeline(`Moved ${clipId} to ${newStart}s.`);
    },
  );

  server.registerTool(
    "delete_clip",
    { description: "Remove a clip, leaving a gap where it was.", inputSchema: { clipId: z.string() } },
    async ({ clipId }) => {
      store.update((p) => deleteClip(p, clipId));
      return timeline(`Deleted ${clipId}.`);
    },
  );

  server.registerTool(
    "ripple_delete",
    { description: "Remove a clip and shift later clips on the same track left to close the gap.", inputSchema: { clipId: z.string() } },
    async ({ clipId }) => {
      store.update((p) => rippleDelete(p, clipId));
      return timeline(`Ripple-deleted ${clipId}.`);
    },
  );

  server.registerTool(
    "compact_track",
    {
      description: "Remove all gaps on a track so its clips play back-to-back from `start`.",
      inputSchema: { trackId: z.string(), start: z.number().min(0).optional() },
    },
    async ({ trackId, start }) => {
      store.update((p) => compactTrack(p, trackId, start ?? 0));
      return timeline(`Compacted track ${trackId}.`);
    },
  );

  // ─────────────────────────────────────────────────────────────── effects

  server.registerTool(
    "set_clip_speed",
    { description: "Change a clip's playback speed (retimes its timeline duration). 2=2× faster, 0.5=slow-mo.", inputSchema: { clipId: z.string(), speed: z.number().positive() } },
    async ({ clipId, speed }) => {
      store.update((p) => setClipSpeed(p, clipId, speed));
      return timeline(`Set ${clipId} speed to ${speed}×.`);
    },
  );

  server.registerTool(
    "set_clip_volume",
    { description: "Set a clip's audio gain (1=unchanged, 0=silent, 1.5=louder).", inputSchema: { clipId: z.string(), volume: z.number().min(0) } },
    async ({ clipId, volume }) => {
      store.update((p) => setClipVolume(p, clipId, volume));
      return timeline(`Set ${clipId} volume to ${volume}.`);
    },
  );

  server.registerTool(
    "set_clip_opacity",
    { description: "Set an overlay/PiP clip's opacity (0..1).", inputSchema: { clipId: z.string(), opacity: z.number().min(0).max(1) } },
    async ({ clipId, opacity }) => {
      store.update((p) => setClipOpacity(p, clipId, opacity));
      return timeline(`Set ${clipId} opacity to ${opacity}.`);
    },
  );

  server.registerTool(
    "set_clip_fades",
    { description: "Set visual fade-in/out (to background) for a clip, in seconds.", inputSchema: { clipId: z.string(), fadeIn: z.number().min(0).optional(), fadeOut: z.number().min(0).optional() } },
    async ({ clipId, fadeIn, fadeOut }) => {
      store.update((p) => setClipFades(p, clipId, { fadeIn, fadeOut }));
      return timeline(`Set visual fades on ${clipId}.`);
    },
  );

  server.registerTool(
    "set_clip_audio_fades",
    { description: "Set audio fade-in/out for a clip, in seconds (great for music beds).", inputSchema: { clipId: z.string(), fadeIn: z.number().min(0).optional(), fadeOut: z.number().min(0).optional() } },
    async ({ clipId, fadeIn, fadeOut }) => {
      store.update((p) => setClipAudioFades(p, clipId, { fadeIn, fadeOut }));
      return timeline(`Set audio fades on ${clipId}.`);
    },
  );

  server.registerTool(
    "set_clip_transform",
    {
      description: "Position/scale/rotate an overlay or PiP clip. x/y are normalized 0..1 (0.5=centered). scale is a fraction of frame width (1=full width). rotation in degrees.",
      inputSchema: {
        clipId: z.string(),
        x: z.number().optional(), y: z.number().optional(),
        scale: z.number().positive().optional(), rotation: z.number().optional(),
      },
    },
    async ({ clipId, x, y, scale, rotation }) => {
      store.update((p) => setClipTransform(p, clipId, { x, y, scale, rotation }));
      return timeline(`Transformed ${clipId}.`);
    },
  );

  server.registerTool(
    "set_transition",
    {
      description: "Set (or clear) the transition from a clip into the NEXT clip on the same main-track sequence. Pass type=null to clear. Duration is the overlap in seconds.",
      inputSchema: {
        clipId: z.string(),
        type: z.enum(TRANSITION_TYPES).nullable().describe("Transition style, or null to remove."),
        duration: z.number().positive().optional().describe("Overlap duration (s), default 0.5."),
      },
    },
    async ({ clipId, type, duration }) => {
      store.update((p) =>
        setTransition(p, clipId, type === null ? null : { type, duration: duration ?? 0.5 }),
      );
      return timeline(type === null ? `Cleared transition on ${clipId}.` : `Set ${type} transition on ${clipId}.`);
    },
  );

  // ────────────────────────────────────────────────────────────────── text

  server.registerTool(
    "add_text",
    {
      description: "Add a text/title overlay to an overlay track. fontSize is a fraction of frame height (0.08≈8%). x/y normalized 0..1. Use \\n in content for line breaks. Returns the new clipId.",
      inputSchema: {
        trackId: z.string(),
        content: z.string(),
        start: z.number().min(0),
        duration: z.number().positive(),
        fontSize: z.number().positive().optional(),
        color: z.string().optional().describe("Hex, e.g. #FFFFFF."),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        align: z.enum(["left", "center", "right"]).optional(),
        background: z.string().optional().describe("Hex box color behind text, omit for none."),
        backgroundOpacity: z.number().min(0).max(1).optional(),
        outlineColor: z.string().optional(),
        outlineWidth: z.number().min(0).optional(),
        x: z.number().optional(), y: z.number().optional(),
      },
    },
    async (args) => {
      const { trackId, content, start, duration, x, y, ...style } = args;
      const { project, clipId } = addText(store.current, {
        trackId, content, start, duration,
        style,
        transform: x !== undefined || y !== undefined ? { x: x ?? 0.5, y: y ?? 0.5 } : undefined,
      });
      store.update(() => project);
      return timeline(`Added text clip [${clipId}].`);
    },
  );

  server.registerTool(
    "update_text",
    {
      description: "Update properties of an existing text overlay clip.",
      inputSchema: {
        clipId: z.string(),
        content: z.string().optional(),
        fontSize: z.number().positive().optional(),
        color: z.string().optional(),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        align: z.enum(["left", "center", "right"]).optional(),
        background: z.string().optional(),
        backgroundOpacity: z.number().min(0).max(1).optional(),
        outlineColor: z.string().optional(),
        outlineWidth: z.number().min(0).optional(),
      },
    },
    async ({ clipId, ...patch }) => {
      store.update((p) => updateText(p, clipId, patch));
      return timeline(`Updated text ${clipId}.`);
    },
  );

  // ──────────────────────────────────────────────────────────────── render

  server.registerTool(
    "render",
    {
      description: "Render the current timeline to an MP4 (H.264/AAC) using FFmpeg. This is the deterministic export step. Returns the output file path. May take a while for long timelines.",
      inputSchema: {
        outputName: z.string().optional().describe("File name (without extension); defaults to the project name."),
      },
    },
    async ({ outputName }) => {
      const project = store.current;
      const safe = (outputName ?? project.name).replace(/[^a-z0-9_\-]+/gi, "_");
      const outputPath = join(store.rendersDir, `${safe}.mp4`);
      let lastPct = -1;
      const result = await renderProject(project, outputPath, {
        workDir: store.workDir,
        onProgress: (pr) => {
          const pct = Math.floor(pr.fraction * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            process.stderr.write(`\rrender ${pct}%   `);
          }
        },
      });
      process.stderr.write("\n");
      return text(`Rendered ${result.duration.toFixed(2)}s → ${result.outputPath}`);
    },
  );

  server.registerTool(
    "create_music_video",
    {
      description:
        "One-shot: turn a cover image + a song into a 1080p music video the full length of the track. Deterministic (FFmpeg), not generative. Two modes: the calm 'Living Cover' (blurred fill + slow Ken Burns zoom + bottom visualizer + grain) and, with reactive=true, a high-energy mode where the whole frame shakes on the beat, zoom-pulses on the bass, and a big full-width rainbow EQ dances to the track — great for drops/club music. Ideal for batch-producing videos in a loop. Returns the output path.",
      inputSchema: {
        coverPath: z.string().describe("Absolute path to the cover image (square works best)."),
        songPath: z.string().describe("Absolute path to the audio file (wav/mp3/m4a…)."),
        outputName: z.string().optional().describe("Output file name (no extension); defaults to the song's name."),
        reactive: z.boolean().optional().describe("High-energy audio-reactive mode: beat shake + bass zoom pulse + big rainbow EQ. Best for club/drops."),
        visualizer: z.enum(["waveform", "bars", "spectrum", "none"]).optional().describe("Visualizer style for non-reactive mode (default bars)."),
        kenBurns: z.boolean().optional().describe("Slow zoom on the cover (default true)."),
        blurFill: z.boolean().optional().describe("Blurred cover fills the frame behind (default true)."),
        filmGrain: z.boolean().optional().describe("Grain + vignette (default true)."),
        accentColor1: z.string().optional().describe("Visualizer hex color 1 (default brand red)."),
        accentColor2: z.string().optional().describe("Visualizer hex color 2 (default brand purple)."),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
      },
    },
    async (a) => {
      const base = (a.outputName ?? a.songPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "")).replace(/[^a-z0-9_\-]+/gi, "_") || "music_video";
      const outputPath = join(store.rendersDir, `${base}.mp4`);
      let lastPct = -1;
      const onProgress = (p: { fraction: number }) => {
        const pct = Math.floor(p.fraction * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          process.stderr.write(`\rmusic-video${a.reactive ? " (reactive)" : ""} ${pct}%   `);
        }
      };
      const result = a.reactive
        ? await renderMusicVideoReactive({
            coverPath: a.coverPath, songPath: a.songPath, outputPath, workDir: store.workDir,
            width: a.width, height: a.height, fps: a.fps, onProgress,
          })
        : await renderMusicVideo({
            coverPath: a.coverPath, songPath: a.songPath, outputPath, workDir: store.workDir,
            width: a.width, height: a.height, fps: a.fps,
            accentColors: a.accentColor1 && a.accentColor2 ? [a.accentColor1, a.accentColor2] : undefined,
            effects: { kenBurns: a.kenBurns, blurFill: a.blurFill, filmGrain: a.filmGrain, visualizer: a.visualizer },
            onProgress,
          });
      process.stderr.write("\n");
      return text(`Rendered ${a.reactive ? "reactive " : ""}music video (${result.duration.toFixed(1)}s) → ${result.outputPath}`);
    },
  );

  return server;
}
