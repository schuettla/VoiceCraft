import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import type { ProjectData, TimelineClip } from "../lib/types";

/* The editor's document state: the project JSON, an undo/redo history stack
 * of full snapshots, selection, playhead, and zoom. Autosave debounces a PUT
 * to the backend whenever `data` settles.
 *
 * History strategy:
 * - A discrete operation (delete clip, add track, split…) pushes the pre-op
 *   snapshot via `apply()`.
 * - A continuous control (a slider, a text field) passes a `coalesce` key to
 *   `apply()`: consecutive applies with the same key collapse into the one
 *   history entry the first of them pushed.
 * - A pointer gesture (dragging a clip or a fade handle) calls
 *   `beginGesture()` on mouse-down and `live()` on every frame. The snapshot
 *   is only pushed on the first `live()`, so a plain click (no movement)
 *   leaves history — and the redo stack — untouched. One drag == one undo step.
 */

export type Selection = { clipIds: Set<string>; trackId: string | null };
export type SaveState = "idle" | "saving" | "saved" | "error";
/** "select": click/drag clips and edges. "razor": click a clip to split it.
 * "range": drag on a lane/ruler to select a time range across tracks. */
export type Tool = "select" | "razor" | "range";
export type SelectionRange = { trackIds: string[]; start: number; end: number };
export type LoopRange = { start: number; end: number };
/** Silence-removal regions to preview on the waveform before cutting —
 * transient UI state, never part of the document or undo history. */
export type PreviewRegions = { clipId: string; ranges: [number, number][] };

type EditorState = {
  projectId: string;
  projectName: string;
  data: ProjectData;
  past: ProjectData[];
  future: ProjectData[];
  /** A gesture has begun but hasn't changed anything yet. */
  gesturePending: boolean;
  /** Key of the last coalescing apply; any other history action clears it. */
  coalesceKey: string | null;
  selection: Selection;
  range: SelectionRange | null;
  tool: Tool;
  snapEnabled: boolean;
  clipboard: TimelineClip[] | null;
  loop: LoopRange | null;
  previewRegions: PreviewRegions | null;
  playhead: number;
  zoom: number; // pixels per second
  saveState: SaveState;
};

type Action =
  | { type: "APPLY"; data: ProjectData; coalesce?: string }
  | { type: "LIVE"; data: ProjectData }
  | { type: "BEGIN_GESTURE" }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "SELECT"; selection: Selection }
  | { type: "SELECT_RANGE"; range: SelectionRange | null }
  | { type: "SET_TOOL"; tool: Tool }
  | { type: "SET_SNAP"; enabled: boolean }
  | { type: "SET_CLIPBOARD"; clips: TimelineClip[] | null }
  | { type: "SET_LOOP"; loop: LoopRange | null }
  | { type: "SET_PREVIEW_REGIONS"; regions: PreviewRegions | null }
  | { type: "PLAYHEAD"; time: number }
  | { type: "ZOOM"; zoom: number }
  | { type: "RENAME"; name: string }
  | { type: "SAVE_STATE"; state: SaveState };

const HISTORY_LIMIT = 100;
const emptySelection: Selection = { clipIds: new Set(), trackId: null };

function pushed(state: EditorState): ProjectData[] {
  return [...state.past, state.data].slice(-HISTORY_LIMIT);
}

function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case "APPLY": {
      if (action.data === state.data) return state;
      const merge = action.coalesce != null && action.coalesce === state.coalesceKey;
      return {
        ...state,
        past: merge ? state.past : pushed(state),
        future: [],
        data: action.data,
        gesturePending: false,
        coalesceKey: action.coalesce ?? null,
      };
    }
    case "LIVE":
      if (action.data === state.data) return state;
      if (state.gesturePending) {
        return { ...state, past: pushed(state), future: [], data: action.data, gesturePending: false };
      }
      return { ...state, data: action.data };
    case "BEGIN_GESTURE":
      return { ...state, gesturePending: true, coalesceKey: null };
    case "UNDO": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ...state,
        data: previous,
        past: state.past.slice(0, -1),
        future: [state.data, ...state.future].slice(0, HISTORY_LIMIT),
        coalesceKey: null,
      };
    }
    case "REDO": {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return { ...state, data: next, future: rest, past: pushed(state), coalesceKey: null };
    }
    case "SELECT":
      return { ...state, selection: action.selection, range: null };
    case "SELECT_RANGE":
      return { ...state, range: action.range, selection: action.range ? emptySelection : state.selection };
    case "SET_TOOL":
      return { ...state, tool: action.tool };
    case "SET_SNAP":
      return { ...state, snapEnabled: action.enabled };
    case "SET_CLIPBOARD":
      return { ...state, clipboard: action.clips };
    case "SET_LOOP":
      return { ...state, loop: action.loop };
    case "SET_PREVIEW_REGIONS":
      return { ...state, previewRegions: action.regions };
    case "PLAYHEAD":
      return { ...state, playhead: Math.max(0, action.time) };
    case "ZOOM":
      return { ...state, zoom: Math.min(400, Math.max(2, action.zoom)) };
    case "RENAME":
      return { ...state, projectName: action.name };
    case "SAVE_STATE":
      return { ...state, saveState: action.state };
    default:
      return state;
  }
}

type EditorApi = {
  state: EditorState;
  apply: (data: ProjectData, options?: { coalesce?: string }) => void;
  live: (data: ProjectData) => void;
  beginGesture: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  select: (selection: Selection) => void;
  selectClip: (clipId: string | null) => void;
  selectRange: (range: SelectionRange | null) => void;
  setTool: (tool: Tool) => void;
  setSnap: (enabled: boolean) => void;
  setClipboard: (clips: TimelineClip[] | null) => void;
  setLoop: (loop: LoopRange | null) => void;
  setPreviewRegions: (regions: PreviewRegions | null) => void;
  setPlayhead: (time: number) => void;
  setZoom: (zoom: number | ((current: number) => number)) => void;
  rename: (name: string) => void;
};

const EditorCtx = createContext<EditorApi | null>(null);

export function useEditor(): EditorApi {
  const value = useContext(EditorCtx);
  if (!value) throw new Error("useEditor must be used inside <EditorProvider>");
  return value;
}

export function EditorProvider({
  projectId,
  projectName,
  initialData,
  children,
}: {
  projectId: string;
  projectName: string;
  initialData: ProjectData;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, {
    projectId,
    projectName,
    data: initialData,
    past: [],
    future: [],
    gesturePending: false,
    coalesceKey: null,
    selection: emptySelection,
    range: null,
    tool: "select",
    snapEnabled: true,
    clipboard: null,
    loop: null,
    previewRegions: null,
    playhead: 0,
    zoom: 40,
    saveState: "idle",
  });

  const zoomRef = useRef(state.zoom);
  zoomRef.current = state.zoom;

  const api_ = useMemo<EditorApi>(
    () => ({
      state,
      apply: (data, options) => dispatch({ type: "APPLY", data, coalesce: options?.coalesce }),
      live: (data) => dispatch({ type: "LIVE", data }),
      beginGesture: () => dispatch({ type: "BEGIN_GESTURE" }),
      undo: () => dispatch({ type: "UNDO" }),
      redo: () => dispatch({ type: "REDO" }),
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      select: (selection) => dispatch({ type: "SELECT", selection }),
      selectClip: (clipId) =>
        dispatch({
          type: "SELECT",
          selection: clipId ? { clipIds: new Set([clipId]), trackId: null } : emptySelection,
        }),
      selectRange: (range) => dispatch({ type: "SELECT_RANGE", range }),
      setTool: (tool) => dispatch({ type: "SET_TOOL", tool }),
      setSnap: (enabled) => dispatch({ type: "SET_SNAP", enabled }),
      setClipboard: (clips) => dispatch({ type: "SET_CLIPBOARD", clips }),
      setLoop: (loop) => dispatch({ type: "SET_LOOP", loop }),
      setPreviewRegions: (regions) => dispatch({ type: "SET_PREVIEW_REGIONS", regions }),
      setPlayhead: (time) => dispatch({ type: "PLAYHEAD", time }),
      setZoom: (zoom) =>
        dispatch({
          type: "ZOOM",
          zoom: typeof zoom === "function" ? zoom(zoomRef.current) : zoom,
        }),
      rename: (name) => dispatch({ type: "RENAME", name }),
    }),
    [state],
  );

  // Autosave: debounce a PUT after the document settles. Nothing is sent for
  // the document as loaded; an edit still pending when the provider unmounts
  // (switching projects, leaving the page) is flushed immediately, not dropped.
  const latest = useRef({ name: state.projectName, data: state.data });
  latest.current = { name: state.projectName, data: state.data };
  const pending = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const loaded = useRef({ name: projectName, data: initialData });

  useEffect(() => {
    if (state.data === loaded.current.data && state.projectName === loaded.current.name) return;
    pending.current = true;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      pending.current = false;
      dispatch({ type: "SAVE_STATE", state: "saving" });
      api
        .saveProject(projectId, latest.current.name, latest.current.data)
        .then(() => dispatch({ type: "SAVE_STATE", state: "saved" }))
        .catch(() => dispatch({ type: "SAVE_STATE", state: "error" }));
    }, 1200);
  }, [state.data, state.projectName, projectId]);

  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current);
      if (pending.current) {
        void api.saveProject(projectId, latest.current.name, latest.current.data).catch(() => undefined);
      }
    },
    [projectId],
  );

  return <EditorCtx.Provider value={api_}>{children}</EditorCtx.Provider>;
}
