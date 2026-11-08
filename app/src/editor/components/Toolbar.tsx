import { useState } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { Badge, IconButton, cx } from "../../components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

const TRACK_KINDS: { value: TrackKind; label: string }[] = [
  { value: "voice", label: "Voice" },
  { value: "music", label: "Music" },
  { value: "sfx", label: "SFX" },
  { value: "other", label: "Other" },
];

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

  function insertSilence(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    editor.apply(ops.insertSilence(data, editor.state.playhead - layout.bodyOffset, seconds, range?.trackIds));
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-card px-3 py-2">
      <IconButton label="Projects" onClick={onOpenProjects}>
        <FolderIcon />
      </IconButton>
      <Input
        value={editor.state.projectName}
        onChange={(e) => editor.rename(e.target.value)}
        aria-label="Project name"
        className="h-8 max-w-[220px] min-w-0 flex-1 border-transparent bg-transparent px-2 font-medium text-white shadow-none hover:border-input focus-visible:bg-transparent dark:bg-transparent"
      />
      <Badge tone={editor.state.saveState === "error" ? "bad" : "neutral"} className={cx(!SAVE_LABEL[editor.state.saveState] && "hidden")}>
        {SAVE_LABEL[editor.state.saveState]}
      </Badge>

      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />

      <IconButton
        label={mediaOpen ? "Hide media panel" : "Show media panel"}
        className={cx(mediaOpen && "bg-accent text-foreground")}
        onClick={onToggleMedia}
      >
        <SidebarIcon />
      </IconButton>

      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />

      <IconButton label="Undo" disabled={!editor.canUndo} onClick={editor.undo}>
        <Undo2 />
      </IconButton>
      <IconButton label="Redo" disabled={!editor.canRedo} onClick={editor.redo}>
        <Redo2 />
      </IconButton>

      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <PlusIcon /> Track
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {TRACK_KINDS.map((kind) => (
            <DropdownMenuItem
              key={kind.value}
              onSelect={() => editor.apply(ops.addTrack(data, kind.value))}
            >
              {kind.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        size="sm"
        variant="ghost"
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

      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />

      <Button size="sm" variant="ghost" disabled={!range} onClick={deleteRange} title="Delete the selected range, leaving a gap">
        Delete range
      </Button>
      <Button size="sm" variant="ghost" disabled={!range} onClick={rippleDeleteRange} title="Delete the selected range and close the gap">
        Ripple delete
      </Button>
      <InsertSilence onInsert={insertSilence} />
      <Button size="sm" variant="ghost" onClick={() => setShowLoudness(true)}>
        Loudness
      </Button>

      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" onClick={() => setShowExport(true)}>
          Export
        </Button>
      </div>

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showSilence && <SilenceDialog onClose={() => setShowSilence(false)} />}
      {showLoudness && <LoudnessDialog onClose={() => setShowLoudness(false)} />}
    </div>
  );
}

/** Opens a gap at the playhead — a popover instead of the old `window.prompt`. */
function InsertSilence({ onInsert }: { onInsert: (seconds: number) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("1");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    onInsert(Number(value));
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" title="Open a gap at the playhead">
          Insert silence
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <form onSubmit={submit} className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            Seconds of silence to insert at the playhead
          </p>
          <div className="flex gap-2">
            <Input
              autoFocus
              type="number"
              min={0.1}
              step={0.1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit" disabled={!(Number(value) > 0)}>
              Insert
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
