import { useState } from "react";
import { Badge, Button, cx, IconButton } from "../../components/ui";
import { FolderIcon, PlusIcon, SidebarIcon, TrashIcon } from "../../components/icons";
import { useEditor } from "../store";
import { useLayout } from "../useLayout";
import * as ops from "../ops";
import type { TrackKind } from "../../lib/types";
import { ExportDialog } from "./ExportDialog";
import { SilenceDialog } from "./SilenceDialog";
import { LoudnessDialog } from "./LoudnessDialog";

const SAVE_LABEL: Record<string, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save",
};

export function Toolbar({
  onOpenProjects,
  mediaOpen,
  onToggleMedia,
}: {
  onOpenProjects: () => void;
  mediaOpen: boolean;
  onToggleMedia: () => void;
}) {
  const editor = useEditor();
  const { durations, layout } = useLayout();
  const data = editor.state.data;
  const [addingTrack, setAddingTrack] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showSilence, setShowSilence] = useState(false);
  const [showLoudness, setShowLoudness] = useState(false);
  const selectedClipId = [...editor.state.selection.clipIds][0];
  const range = editor.state.range;

  // Ranges/playhead are timeline time (0 = start of the intro, matching the
  // ruler); clip positions are body time — convert before touching clips.
  function deleteRange() {
    if (!range) return;
    editor.apply(
      ops.deleteRange(data, range.start - layout.bodyOffset, range.end - layout.bodyOffset, durations, range.trackIds),
    );
    editor.selectRange(null);
  }

  function rippleDeleteRange() {
    if (!range) return;
    editor.apply(
      ops.rippleDeleteRange(
        data, range.start - layout.bodyOffset, range.end - layout.bodyOffset, durations, range.trackIds,
      ),
    );
    editor.selectRange(null);
  }

  function insertSilence() {
    const raw = window.prompt("Insert how many seconds of silence at the playhead?", "1");
    const seconds = raw ? Number(raw) : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    editor.apply(ops.insertSilence(data, editor.state.playhead - layout.bodyOffset, seconds, range?.trackIds));
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-900 px-3 py-2">
      <IconButton label="Projects" onClick={onOpenProjects}>
        <FolderIcon />
      </IconButton>
      <input
        value={editor.state.projectName}
        onChange={(e) => editor.rename(e.target.value)}
        className="min-w-0 max-w-[220px] flex-1 truncate bg-transparent text-[14px] font-medium text-white focus:outline-none"
      />
      <Badge tone={editor.state.saveState === "error" ? "bad" : "neutral"}>
        {SAVE_LABEL[editor.state.saveState]}
      </Badge>

      <div className="mx-1 h-5 w-px bg-ink-700" />

      <IconButton
        label={mediaOpen ? "Hide media panel" : "Show media panel"}
        className={cx(mediaOpen && "bg-white/10 text-white")}
        onClick={onToggleMedia}
      >
        <SidebarIcon />
      </IconButton>

      <div className="mx-1 h-5 w-px bg-ink-700" />

      <IconButton label="Undo" disabled={!editor.canUndo} onClick={editor.undo}>
        <UndoIcon />
      </IconButton>
      <IconButton label="Redo" disabled={!editor.canRedo} onClick={editor.redo}>
        <RedoIcon />
      </IconButton>

      <div className="mx-1 h-5 w-px bg-ink-700" />

      {addingTrack ? (
        <select
          autoFocus
          value=""
          onBlur={() => setAddingTrack(false)}
          onChange={(e) => {
            editor.apply(ops.addTrack(data, e.target.value as TrackKind));
            setAddingTrack(false);
          }}
          className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-[12px] text-ink-200"
        >
          <option value="">Kind…</option>
          <option value="voice">Voice</option>
          <option value="music">Music</option>
          <option value="sfx">SFX</option>
          <option value="other">Other</option>
        </select>
      ) : (
        <Button size="sm" onClick={() => setAddingTrack(true)}>
          <PlusIcon /> Track
        </Button>
      )}

      <Button
        size="sm"
        disabled={!selectedClipId}
        onClick={() => setShowSilence(true)}
        title="Detect and remove long quiet stretches"
      >
        Remove silence
      </Button>

      <IconButton
        label="Delete selected clip"
        disabled={!selectedClipId}
        className="hover:text-coral-red"
        onClick={() => {
          if (selectedClipId) {
            editor.apply(ops.removeClip(data, selectedClipId));
            editor.selectClip(null);
          }
        }}
      >
        <TrashIcon />
      </IconButton>

      <div className="mx-1 h-5 w-px bg-ink-700" />

      <Button size="sm" disabled={!range} onClick={deleteRange} title="Delete the selected range, leaving a gap">
        Delete range
      </Button>
      <Button size="sm" disabled={!range} onClick={rippleDeleteRange} title="Delete the selected range and close the gap">
        Ripple delete
      </Button>
      <Button size="sm" onClick={insertSilence} title="Open a gap at the playhead">
        Insert silence
      </Button>
      <Button size="sm" onClick={() => setShowLoudness(true)}>
        Loudness
      </Button>

      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => setShowExport(true)}>
          Export
        </Button>
      </div>

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showSilence && <SilenceDialog onClose={() => setShowSilence(false)} />}
      {showLoudness && <LoudnessDialog onClose={() => setShowLoudness(false)} />}
    </div>
  );
}

function UndoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h6.5a3.5 3.5 0 0 1 0 7H8M4 6l3-3M4 6l3 3" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 6H5.5a3.5 3.5 0 0 0 0 7H8M12 6l-3-3M12 6l-3 3" />
    </svg>
  );
}
