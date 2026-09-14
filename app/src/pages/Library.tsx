import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Asset, Generation, Profile } from "../lib/types";
import {
  formatBytes,
  formatDuration,
  formatWhen,
  truncate,
} from "../lib/format";
import { usePreferences } from "../lib/preferences";
import { useToast } from "../components/Toaster";
import { TrackRow } from "../components/TrackRow";
import { Badge, Button, Empty, IconButton, Segmented, Select } from "../components/ui";
import { DownloadIcon, FolderIcon, SearchIcon, TrashIcon } from "../components/icons";

const ACTIVE: Generation["status"][] = ["queued", "processing"];

type Mode = "all" | "completed" | "failed" | "exports";

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

  const visibleGenerations = useMemo(() => {
    if (showingExports) return [];
    const needle = query.trim().toLowerCase();
    return generations.filter((g) => {
      if (mode === "completed" && g.status !== "completed") return false;
      if (mode === "failed" && g.status !== "failed") return false;
      if (voiceId && g.profile_id !== voiceId) return false;
      if (needle && !g.text.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [generations, mode, voiceId, query, showingExports]);

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
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-medium tracking-tight text-white">Library</h1>
        <p className="mt-1 text-[13px] text-ink-400">
          {shownCount} shown · {formatDuration(totalSeconds)} of audio
        </p>
      </div>

      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-ink-700 bg-ink-900 p-2">
        <div className="relative min-w-[200px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={query}
            placeholder={showingExports ? "Search exports…" : "Search scripts…"}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-white/[0.02] py-2 pl-9 pr-3 text-sm text-ink-200 placeholder:text-ink-400 focus:border-ink-200 focus:outline-none"
          />
        </div>
        <Select
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          disabled={showingExports}
          className="w-auto min-w-[140px]"
        >
          <option value="">All voices</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Segmented
          options={MODES}
          value={mode}
          onChange={(next) => {
            setMode(next);
            setSelected(new Set());
          }}
        />
      </div>

      <div className="rounded-xl border border-ink-700 bg-ink-900">
        <div className="flex items-center gap-3 border-b border-ink-700 px-4 py-2.5">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(rowIds) : new Set())
            }
            className="size-3.5 accent-accent"
            aria-label="Select all"
          />
          {selectedHere.length > 0 ? (
            <>
              <span className="text-[13px] text-ink-200">
                {selectedHere.length} selected
              </span>
              <Button
                size="sm"
                variant="danger"
                className="ml-auto"
                onClick={deleteSelected}
              >
                Delete selected
              </Button>
              <Button size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </>
          ) : (
            <span className="text-[11px] uppercase tracking-wide text-ink-400">
              {showingExports ? "Exported file" : "Script"}
            </span>
          )}
        </div>

        <div className="p-2">
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
              const who = g.profile_id
                ? (names.get(g.profile_id) ?? "deleted voice")
                : undefined;
              const active = ACTIVE.includes(g.status);
              return (
                <TrackRow
                  key={g.id}
                  busy={active}
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
    </div>
  );
}
