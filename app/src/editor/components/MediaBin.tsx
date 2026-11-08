import { useState } from "react";
import { formatDuration } from "../../lib/format";
import { useToast } from "../../components/Toaster";
import { TrackRow } from "../../components/TrackRow";
import { Badge, Empty, IconButton, OptionSelect } from "../../components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlusIcon, SearchIcon, TrashIcon } from "../../components/icons";
import { useMedia, MEDIA_KIND_LABEL, type MediaClip } from "../MediaContext";
import { useEditor } from "../store";
import * as ops from "../ops";

export const MEDIA_DRAG_MIME = "application/x-voicecraft-media-key";

type Filter = "all" | "voices" | "music" | "sfx" | "io" | "clips" | "outputs";

/** The left panel: every source in the app, searchable, draggable onto the
 * timeline. Doubles as the intro/outro/clip import point (button + OS drop). */
export function MediaBin() {
  const media = useMedia();
  const editor = useEditor();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [importing, setImporting] = useState(false);

  const visible = media.clips.filter((c) => {
    if (filter === "voices" && c.kind !== "voice") return false;
    if (filter === "music" && c.kind !== "music") return false;
    if (filter === "sfx" && c.kind !== "sfx") return false;
    if (filter === "io" && c.kind !== "intro" && c.kind !== "outro") return false;
    if (filter === "clips" && c.kind !== "clip") return false;
    if (filter === "outputs" && c.kind !== "output") return false;
    const needle = query.trim().toLowerCase();
    return !needle || c.title.toLowerCase().includes(needle);
  });

  const firstTrack = editor.state.data.tracks[0]?.id;

  function addSelectedTo(clip: MediaClip) {
    if (!firstTrack) return;
    editor.apply(ops.addClip(editor.state.data, firstTrack, clip.ref, 0, clip.duration ?? 0));
  }

  async function onDropFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.set("name", file.name.replace(/\.[^.]+$/, ""));
      form.set("kind", "clip");
      form.set("file", file);
      try {
        await media.uploadAsset(form);
      } catch (error) {
        toast((error as Error).message, "error");
      }
    }
  }

  return (
    <div
      className="flex h-full flex-col gap-3 border-r bg-card p-3"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void onDropFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-medium text-foreground">Media</h2>
        <IconButton label="Import audio file" onClick={() => setImporting((v) => !v)}>
          <PlusIcon />
        </IconButton>
      </div>

      {importing && <ImportForm onDone={() => setImporting(false)} />}

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          placeholder="Search…"
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 pl-8"
        />
      </div>
      <OptionSelect
        size="sm"
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        options={[
          { value: "all", label: "All media" },
          { value: "voices", label: "Voices" },
          { value: "music", label: "Music" },
          { value: "sfx", label: "Sound FX" },
          { value: "io", label: "Intros & outros" },
          { value: "clips", label: "Clips" },
          { value: "outputs", label: "Exports" },
        ]}
      />

      <div className="min-h-0 flex-1 divide-y overflow-y-auto border-y">
        {visible.length === 0 ? (
          <Empty>Nothing here yet — drop an audio file to import it.</Empty>
        ) : (
          visible.map((clip) => (
            <div
              key={clip.key}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(MEDIA_DRAG_MIME, clip.key);
                e.dataTransfer.effectAllowed = "copy";
              }}
              className="cursor-grab active:cursor-grabbing"
            >
              <TrackRow
                track={{ id: clip.key, path: clip.path, title: clip.title }}
                badge={clip.kind !== "voice" ? <Badge tone="neutral">{MEDIA_KIND_LABEL[clip.kind]}</Badge> : undefined}
                meta={formatDuration(clip.duration)}
                actions={
                  <>
                    <IconButton label="Add to timeline" onClick={() => addSelectedTo(clip)}>
                      <PlusIcon />
                    </IconButton>
                    {clip.assetId && (
                      <IconButton
                        label="Delete"
                        className="hover:text-coral-red"
                        onClick={() => media.deleteAsset(clip.assetId!)}
                      >
                        <TrashIcon />
                      </IconButton>
                    )}
                  </>
                }
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ImportForm({ onDone }: { onDone: () => void }) {
  const media = useMedia();
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"clip" | "intro" | "outro">("clip");
  const [busy, setBusy] = useState(false);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("file") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("name", name || file.name.replace(/\.[^.]+$/, ""));
      form.set("kind", kind);
      form.set("file", file);
      await media.uploadAsset(form);
      toast("Imported", "success");
      onDone();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={upload} className="space-y-2 border-b pb-3">
      <div className="flex gap-1.5">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
          className="h-8 min-w-0 flex-1"
        />
        <OptionSelect
          size="sm"
          className="w-24"
          value={kind}
          onChange={(value) => setKind(value as typeof kind)}
          options={[
            { value: "clip", label: "Clip" },
            { value: "intro", label: "Intro" },
            { value: "outro", label: "Outro" },
          ]}
        />
      </div>
      <Input type="file" name="file" accept="audio/*" className="h-8 text-xs" />
      <Button type="submit" size="sm" className="w-full" disabled={busy}>
        {busy ? "Uploading…" : "Add"}
      </Button>
    </form>
  );
}
