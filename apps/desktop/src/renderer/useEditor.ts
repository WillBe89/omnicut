import { useCallback, useEffect, useRef, useState } from "react";
import {
  addClip, addMedia, addText, deleteClip, moveClip, rippleDelete,
  setClipAudioFades, setClipFades, setClipOpacity, setClipSpeed,
  setClipTransform, setClipVolume, setTransition, splitClip, trimClip,
  updateText,
  type MediaAsset, type Project, type TextStyle, type Transform, type Transition,
} from "@video-editor/core";

const api = window.api;

export interface Editor {
  project: Project | null;
  selectedClipId: string | null;
  select: (id: string | null) => void;
  loading: boolean;
  // lifecycle
  newProject: (name: string, settings: Partial<Project["settings"]>) => Promise<void>;
  openProject: (path: string) => Promise<void>;
  importMedia: () => Promise<void>;
  addToTimeline: (asset: MediaAsset) => void;
  // edits
  edit: (fn: (p: Project) => Project) => void;
  splitAt: (clipId: string, t: number) => void;
  removeClip: (clipId: string, ripple: boolean) => void;
  setSpeed: (clipId: string, speed: number) => void;
  setVolume: (clipId: string, v: number) => void;
  setOpacity: (clipId: string, v: number) => void;
  setFades: (clipId: string, f: { fadeIn?: number; fadeOut?: number }) => void;
  setAudioFades: (clipId: string, f: { fadeIn?: number; fadeOut?: number }) => void;
  setTransform: (clipId: string, t: Partial<Transform>) => void;
  setClipTransition: (clipId: string, t: Transition | null) => void;
  moveClipTo: (clipId: string, start: number, trackId?: string) => void;
  trim: (clipId: string, sourceIn?: number, sourceOut?: number) => void;
  addTitle: (opts: { content: string; start: number; duration: number }) => void;
  editText: (clipId: string, patch: Partial<TextStyle>) => void;
  // history
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useEditor(): Editor {
  const [project, setProject] = useState<Project | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const undoStack = useRef<Project[]>([]);
  const redoStack = useRef<Project[]>([]);
  const [histTick, setHistTick] = useState(0);
  const externalUpdate = useRef(false);

  // Initial load + live-reload subscription.
  useEffect(() => {
    let unsub = () => {};
    api.getInitial().then(({ project }) => {
      setProject(project);
      setLoading(false);
    });
    unsub = api.onProjectChanged((p) => {
      externalUpdate.current = true;
      undoStack.current = [];
      redoStack.current = [];
      setProject(p);
      setHistTick((t) => t + 1);
    });
    return () => unsub();
  }, []);

  const commit = useCallback((next: Project, current: Project | null) => {
    if (current) {
      undoStack.current.push(current);
      if (undoStack.current.length > 100) undoStack.current.shift();
    }
    redoStack.current = [];
    setProject(next);
    setHistTick((t) => t + 1);
    void api.saveProject(next);
  }, []);

  const edit = useCallback(
    (fn: (p: Project) => Project) => {
      setProject((cur) => {
        if (!cur) return cur;
        const next = fn(cur);
        undoStack.current.push(cur);
        if (undoStack.current.length > 100) undoStack.current.shift();
        redoStack.current = [];
        void api.saveProject(next);
        setHistTick((t) => t + 1);
        return next;
      });
    },
    [],
  );

  const newProject = useCallback(async (name: string, settings: Partial<Project["settings"]>) => {
    const p = await api.createProject(name, settings);
    undoStack.current = [];
    redoStack.current = [];
    setProject(p);
    setSelectedClipId(null);
  }, []);

  const openProject = useCallback(async (path: string) => {
    const p = await api.openProject(path);
    undoStack.current = [];
    redoStack.current = [];
    setProject(p);
    setSelectedClipId(null);
  }, []);

  const importMedia = useCallback(async () => {
    const paths = await api.pickMediaFiles();
    if (paths.length === 0) return;
    const metas = await api.probeMedia(paths);
    setProject((cur) => {
      if (!cur) return cur;
      let next = cur;
      for (const meta of metas) next = addMedia(next, meta).project;
      undoStack.current.push(cur);
      redoStack.current = [];
      void api.saveProject(next);
      setHistTick((t) => t + 1);
      return next;
    });
  }, []);

  const addToTimeline = useCallback((asset: MediaAsset) => {
    edit((p) => {
      const wantType = asset.type === "audio" ? "audio" : "video";
      const track = p.tracks.find((t) => t.type === wantType) ?? p.tracks[0];
      if (!track) return p;
      return addClip(p, { trackId: track.id, assetId: asset.id }).project;
    });
  }, [edit]);

  const undo = useCallback(() => {
    setProject((cur) => {
      const prev = undoStack.current.pop();
      if (!prev || !cur) return cur;
      redoStack.current.push(cur);
      void api.saveProject(prev);
      setHistTick((t) => t + 1);
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    setProject((cur) => {
      const next = redoStack.current.pop();
      if (!next || !cur) return cur;
      undoStack.current.push(cur);
      void api.saveProject(next);
      setHistTick((t) => t + 1);
      return next;
    });
  }, []);

  return {
    project,
    selectedClipId,
    select: setSelectedClipId,
    loading,
    newProject,
    openProject,
    importMedia,
    addToTimeline,
    edit,
    splitAt: (clipId, t) => edit((p) => splitClip(p, clipId, t).project),
    removeClip: (clipId, ripple) => {
      edit((p) => (ripple ? rippleDelete(p, clipId) : deleteClip(p, clipId)));
      setSelectedClipId((s) => (s === clipId ? null : s));
    },
    setSpeed: (clipId, speed) => edit((p) => setClipSpeed(p, clipId, speed)),
    setVolume: (clipId, v) => edit((p) => setClipVolume(p, clipId, v)),
    setOpacity: (clipId, v) => edit((p) => setClipOpacity(p, clipId, v)),
    setFades: (clipId, f) => edit((p) => setClipFades(p, clipId, f)),
    setAudioFades: (clipId, f) => edit((p) => setClipAudioFades(p, clipId, f)),
    setTransform: (clipId, t) => edit((p) => setClipTransform(p, clipId, t)),
    setClipTransition: (clipId, t) => edit((p) => setTransition(p, clipId, t)),
    moveClipTo: (clipId, start, trackId) => edit((p) => moveClip(p, clipId, start, trackId)),
    trim: (clipId, sourceIn, sourceOut) => edit((p) => trimClip(p, { clipId, sourceIn, sourceOut })),
    addTitle: (opts) =>
      edit((p) => {
        const track = p.tracks.find((t) => t.type === "overlay") ?? p.tracks[0]!;
        return addText(p, { trackId: track.id, ...opts }).project;
      }),
    editText: (clipId, patch) => edit((p) => updateText(p, clipId, patch)),
    undo,
    redo,
    // histTick forces this hook's consumers to re-render after each history change.
    canUndo: histTick >= 0 && undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  };
}
