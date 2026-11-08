import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Asset, Generation, GenerationKind, Profile } from "../lib/types";
import {
  formatBytes,
  formatDuration,
  formatWhen,
  truncate,
} from "../lib/format";
import { usePreferences } from "../lib/preferences";
import { useToast } from "../components/Toaster";
import { TrackRow } from "../components/TrackRow";
import { KindIcon } from "../components/KindIcon";
import {
  Badge,
  Empty,
  IconButton,
  OptionSelect,
  PageHeader,
  Segmented,
} from "../components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DownloadIcon, FolderIcon, SearchIcon, TrashIcon } from "../components/icons";

const ACTIVE: Generation["status"][] = ["queued", "processing"];

type Mode = "all" | "completed" | "failed" | "exports";
type TypeFilter = "all" | GenerationKind;

const TYPES: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "speech", label: "Voice" },
  { value: "music", label: "Music" },
  { value: "sfx", label: "Sound FX" },
];

const MODES: { value: Mode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "exports", label: "Exports" },
];

/** The full record of everything the app has produced — every generation and
 * every export — as one dense, searchable, selectable list. */
export function LibraryPage() {
  const toast = useToast();
  const preferences = usePreferences();
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [exports, setExports] = useState<Asset[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [query, setQuery] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [mode, setMode] = useState<Mode>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [gens, assets, people] = await Promise.all([
        api.listGenerations(500),
        api.listAssets(),
        api.listProfiles(),
      ]);
      setGenerations(gens);
      setExports(assets.filter((a) => a.kind === "output"));
      setProfiles(people);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = generations.some((g) => ACTIVE.includes(g.status));
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  const names = useMemo(
    () => new Map(profiles.map((p) => [p.id, p.name])),
    [profiles],
  );

  const showingExports = mode === "exports";
  // A voice only exists for speech, so the voice filter means nothing for
  // music or sound effects and is hidden (and ignored) there.
  const voiceFilterApplies = type === "all" || type === "speech";

  const visibleGenerations = useMemo(() => {
    if (showingExports) return [];
    const needle = query.trim().toLowerCase();
    return generations.filter((g) => {
      if (mode === "completed" && g.status !== "completed") return false;
      if (mode === "failed" && g.status !== "failed") return false;
      if (type !== "all" && g.kind !== type) return false;
      if (voiceFilterApplies && voiceId && g.profile_id !== voiceId) return false;
      if (needle && !g.text.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [generations, mode, type, voiceId, voiceFilterApplies, query, showingExports]);

  const visibleExports = useMemo(() => {
    if (!showingExports) return [];
    const needle = query.trim().toLowerCase();
    return exports.filter((a) => !needle || a.name.toLowerCase().includes(needle));
  }, [exports, query, showingExports]);

  const rowIds = showingExports
    ? visibleExports.map((a) => a.id)
    : visibleGenerations.map((g) => g.id);
  const selectedHere = rowIds.filter((id) => selected.has(id));
  const allSelected = rowIds.length > 0 && selectedHere.length === rowIds.length;

  function toggle(id: string, next: boolean) {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }

  async function deleteSelected() {
    const ids = [...selected];
    try {
      await Promise.all(
        ids.map((id) =>
          showingExports ? api.deleteAsset(id) : api.deleteGeneration(id),
        ),
      );
      toast(`Deleted ${ids.length} item${ids.length === 1 ? "" : "s"}`, "success");
      setSelected(new Set());
      await refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function reveal(path: string) {
    try {
      await api.reveal(path);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function exportGeneration(id: string) {
    try {
      const asset = await api.convert({
        generation_id: id,
        output_format: preferences.default_output_format,
      });
      toast(`Exported ${asset.name}`, "success");
      await refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  const totalSeconds = showingExports
    ? visibleExports.reduce((s, a) => s + (a.duration_seconds ?? 0), 0)
    : visibleGenerations.reduce((s, g) => s + (g.duration_seconds ?? 0), 0);
  const shownCount = showingExports ? visibleExports.length : visibleGenerations.length;

  return (
    <>
      <PageHeader
        title="Library"
        description={`${shownCount} shown · ${formatDuration(totalSeconds)} of audio`}
      />

      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 bg-background px-1 pb-4">
        <div className="relative min-w-[200px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            placeholder={showingExports ? "Search exports…" : "Search scripts…"}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <OptionSelect
          value={type}
          onChange={(value) => {
            setType(value as TypeFilter);
            setSelected(new Set());
          }}
          disabled={showingExports}
          className="w-36"
          options={TYPES}
        />
        {voiceFilterApplies && (
          <OptionSelect
            value={voiceId || "__all"}
            onChange={(value) => setVoiceId(value === "__all" ? "" : value)}
            disabled={showingExports}
            className="w-44"
            options={[
              { value: "__all", label: "All voices" },
              ...profiles.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        )}
        <Segmented
          options={MODES}
          value={mode}
          onChange={(next) => {
            setMode(next);
            setSelected(new Set());
          }}
        />
      </div>

      <div className="border-y">
        <div className="flex h-11 items-center gap-3 border-b px-2">
          <Checkbox
            checked={allSelected}
            onCheckedChange={(next) =>
              setSelected(next === true ? new Set(rowIds) : new Set())
            }
            aria-label="Select all"
          />
          {selectedHere.length > 0 ? (
            <>
              <span className="text-[13px] text-foreground">
                {selectedHere.length} selected
              </span>
              <Button
                size="sm"
                variant="destructive"
                className="ml-auto"
                onClick={deleteSelected}
              >
                Delete selected
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </>
          ) : (
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {showingExports ? "Exported file" : "Script"}
            </span>
          )}
        </div>

        <div className="divide-y">
          {shownCount === 0 ? (
            <Empty>
              {showingExports
                ? "No exports yet. Use the export action on any completed generation."
                : generations.length === 0
                  ? "Nothing generated yet — the Generate tab is where audio starts."
                  : "No generation matches those filters."}
            </Empty>
          ) : showingExports ? (
            visibleExports.map((asset) => (
              <TrackRow
                key={asset.id}
                selected={selected.has(asset.id)}
                onSelectedChange={(next) => toggle(asset.id, next)}
                track={{ id: asset.id, path: asset.path, title: asset.name }}
                meta={[
                  asset.format.toUpperCase(),
                  formatDuration(asset.duration_seconds),
                  formatBytes(asset.size_bytes),
                  formatWhen(asset.created_at),
                ].join(" · ")}
                actions={
                  <>
                    <IconButton label="Show file" onClick={() => reveal(asset.path)}>
                      <FolderIcon />
                    </IconButton>
                    <IconButton
                      label="Delete"
                      className="hover:text-coral-red"
                      onClick={async () => {
                        await api.deleteAsset(asset.id);
                        await refresh();
                      }}
                    >
                      <TrashIcon />
                    </IconButton>
                  </>
                }
              />
            ))
          ) : (
            visibleGenerations.map((g) => {
              const done = g.status === "completed" && !!g.audio_path;
              // Only speech has a voice; music and sound effects never do, so
              // they must not read "deleted voice".
              const who =
                g.kind === "speech" && g.profile_id
                  ? (names.get(g.profile_id) ?? "deleted voice")
                  : undefined;
              const active = ACTIVE.includes(g.status);
              return (
                <TrackRow
                  key={g.id}
                  busy={active}
                  leading={<KindIcon kind={g.kind} />}
                  title={truncate(g.text, 120)}
                  selected={selected.has(g.id)}
                  onSelectedChange={(next) => toggle(g.id, next)}
                  track={
                    done
                      ? {
                          id: g.id,
                          path: g.audio_path!,
                          title: truncate(g.text, 120),
                          subtitle: who,
                        }
                      : undefined
                  }
                  badge={
                    g.status === "failed" ? (
                      <Badge tone="bad">failed</Badge>
                    ) : active ? (
                      <Badge tone="busy">{g.status}</Badge>
                    ) : undefined
                  }
                  meta={
                    g.status === "failed" ? (
                      <span className="text-coral-red">
                        {g.error ?? "Generation failed"}
                      </span>
                    ) : (
                      [
                        who,
                        formatWhen(g.created_at),
                        g.duration_seconds != null &&
                          formatDuration(g.duration_seconds),
                        g.format?.toUpperCase(),
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    )
                  }
                  actions={
                    <>
                      {done && (
                        <>
                          <IconButton
                            label="Show file"
                            onClick={() => reveal(g.audio_path!)}
                          >
                            <FolderIcon />
                          </IconButton>
                          <IconButton
                            label={`Export as ${preferences.default_output_format.toUpperCase()}`}
                            onClick={() => exportGeneration(g.id)}
                          >
                            <DownloadIcon />
                          </IconButton>
                        </>
                      )}
                      <IconButton
                        label="Delete"
                        className="hover:text-coral-red"
                        onClick={async () => {
                          await api.deleteGeneration(g.id);
                          await refresh();
                        }}
                      >
                        <TrashIcon />
                      </IconButton>
                    </>
                  }
                />
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
