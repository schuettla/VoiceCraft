import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FilterX,
  MoreHorizontal,
  Pencil,
  Star,
  UserRound,
} from "lucide-react";
import { api } from "../lib/api";
import type { Generation, Profile } from "../lib/types";
import {
  formatBytes,
  formatDuration,
  formatTotal,
  formatWhen,
  truncate,
} from "../lib/format";
import {
  GROUP_LABEL,
  SORT_LABEL,
  TYPE_LABEL,
  groupItems,
  groupOptions,
  matches,
  sortItems,
  toItems,
  type Filters,
  type GroupBy,
  type LibraryItem,
  type SortBy,
  type StatusFilter,
  type TypeTab,
} from "../lib/library";
import { usePreferences } from "../lib/preferences";
import { useRemembered } from "../lib/remember";
import { useToast } from "../components/Toaster";
import { useConfirm } from "../components/Confirm";
import { TrackRow } from "../components/TrackRow";
import { KindIcon } from "../components/KindIcon";
import { GenerationDetails } from "../components/GenerationDetails";
import { LibraryStatus, type StatusCounts } from "../components/LibraryStatus";
import type { GenerateHandoff } from "./Generate";
import { Badge, Empty, IconButton, OptionSelect, PageHeader } from "../components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import { DownloadIcon, FolderIcon, SearchIcon, TrashIcon } from "../components/icons";
import { cn } from "@/lib/utils";

const ACTIVE: Generation["status"][] = ["queued", "processing"];
/** The backend's ceiling for one list call (`routes/generate.py` LIST_MAX). */
const ALL_GENERATIONS = 100_000;

const TABS: readonly TypeTab[] = ["all", "speech", "music", "sfx", "export"];
const TAB_LABEL: Record<TypeTab, string> = { all: "All", ...TYPE_LABEL };
const GROUPS = Object.keys(GROUP_LABEL) as GroupBy[];
const SORTS = Object.keys(SORT_LABEL) as SortBy[];

/** What the first column of the list holds, per tab. */
const COLUMN_LABEL: Record<TypeTab, string> = {
  all: "Clip",
  speech: "Script",
  music: "Style prompt",
  sfx: "Description",
  export: "Exported file",
};

const SEARCH_PLACEHOLDER: Record<TypeTab, string> = {
  all: "Search the library…",
  speech: "Search scripts…",
  music: "Search prompts and lyrics…",
  sfx: "Search descriptions…",
  export: "Search exports…",
};

const NO_FILTERS = { status: "all" as StatusFilter, voiceId: "", query: "", favoritesOnly: false };

/**
 * Everything the app has produced — generations and exports — as one searchable,
 * sortable, groupable, selectable list. *What* a thing is leads (the tabs); where
 * it stands (ready / generating / failed) is a quieter second filter.
 */
export function LibraryPage({
  onOpenInGenerate,
}: {
  /** Send a clip or a script back to the Generate page. */
  onOpenInGenerate: (handoff: GenerateHandoff) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const preferences = usePreferences();

  const [generations, setGenerations] = useState<Generation[]>([]);
  const [exportedFiles, setExportedFiles] = useState<Awaited<ReturnType<typeof api.listAssets>>>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [tab, setTab] = useRemembered<TypeTab>("voicecraft.library.tab", "all", TABS);
  const [groupChoice, setGroupChoice] = useRemembered<GroupBy>("voicecraft.library.group", "date", GROUPS);
  const [sort, setSort] = useRemembered<SortBy>("voicecraft.library.sort", "newest", SORTS);
  const [query, setQuery] = useState(NO_FILTERS.query);
  const [status, setStatus] = useState<StatusFilter>(NO_FILTERS.status);
  const [voiceId, setVoiceId] = useState(NO_FILTERS.voiceId);
  const [favoritesOnly, setFavoritesOnly] = useState(NO_FILTERS.favoritesOnly);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [gens, assets, people] = await Promise.all([
        // Everything: the Library filters, groups and counts the whole history.
        api.listGenerations(ALL_GENERATIONS),
        api.listAssets(),
        api.listProfiles(),
      ]);
      setGenerations(gens);
      setExportedFiles(assets.filter((a) => a.kind === "output"));
      setProfiles(people);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setLoaded(true);
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

  const voiceNames = useMemo(() => new Map(profiles.map((p) => [p.id, p.name])), [profiles]);
  const items = useMemo(
    () => toItems(generations, exportedFiles, voiceNames),
    [generations, exportedFiles, voiceNames],
  );

  // ---- filtering -----------------------------------------------------------
  // Exports are files: they have no status, voice or favorite to filter on.
  const onExports = tab === "export";
  const filters: Filters = {
    tab,
    status: onExports ? "all" : status,
    voiceId: tab === "speech" ? voiceId : "",
    query,
    favoritesOnly: onExports ? false : favoritesOnly,
  };

  const tabCounts = useMemo(() => {
    const counts = {} as Record<TypeTab, number>;
    for (const t of TABS) {
      const base: Filters = { ...filters, tab: t, status: "all", favoritesOnly: t === "export" ? false : favoritesOnly };
      counts[t] = items.filter((item) => matches(item, base)).length;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query, favoritesOnly, voiceId]);

  const statusCounts = useMemo<StatusCounts>(() => {
    const counts: StatusCounts = { all: 0, ready: 0, active: 0, failed: 0 };
    for (const item of items) {
      if (!matches(item, filters, ["status"])) continue;
      counts.all += 1;
      counts[item.status] += 1;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, tab, query, favoritesOnly, voiceId]);

  const visible = useMemo(
    () => sortItems(items.filter((item) => matches(item, filters)), sort),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, tab, status, query, favoritesOnly, voiceId, sort],
  );

  const groupChoices = groupOptions(tab);
  const group: GroupBy = groupChoices.includes(groupChoice) ? groupChoice : "date";
  const groups = useMemo(() => groupItems(visible, group, sort), [visible, group, sort]);
  const groupKey = (key: string) => `${group}:${key}`;

  const totalSeconds = visible.reduce((sum, item) => sum + (item.seconds ?? 0), 0);
  const anyFilter = !!query || status !== "all" || favoritesOnly || (tab === "speech" && !!voiceId);

  function clearFilters() {
    setQuery(NO_FILTERS.query);
    setStatus(NO_FILTERS.status);
    setVoiceId(NO_FILTERS.voiceId);
    setFavoritesOnly(NO_FILTERS.favoritesOnly);
  }

  function changeTab(next: TypeTab) {
    setTab(next);
    setSelected(new Set());
    anchor.current = null;
  }

  // ---- selection -----------------------------------------------------------
  // Only what is on screen counts as selected: a filter change must never leave
  // an invisible selection that a later "Delete" would take with it.
  const visibleIds = useMemo(() => visible.map((item) => item.id), [visible]);
  const selectedItems = useMemo(
    () => visible.filter((item) => selected.has(item.id)),
    [visible, selected],
  );
  const allSelected = visible.length > 0 && selectedItems.length === visible.length;

  // Order of the rows actually on screen — shift-click ranges follow it.
  const rowOrder = useMemo(
    () =>
      groups.flatMap((g) => (collapsed.has(`${group}:${g.key}`) ? [] : g.items.map((i) => i.id))),
    [groups, collapsed, group],
  );

  function select(id: string, next: boolean, range: boolean) {
    setSelected((current) => {
      const copy = new Set(current);
      const from = anchor.current ? rowOrder.indexOf(anchor.current) : -1;
      const to = rowOrder.indexOf(id);
      if (range && from !== -1 && to !== -1) {
        for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
          if (next) copy.add(rowOrder[i]);
          else copy.delete(rowOrder[i]);
        }
      } else if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
    anchor.current = id;
  }

  function selectGroup(ids: string[], next: boolean) {
    setSelected((current) => {
      const copy = new Set(current);
      for (const id of ids) {
        if (next) copy.add(id);
        else copy.delete(id);
      }
      return copy;
    });
  }

  // ---- actions -------------------------------------------------------------
  async function deleteItems(targets: LibraryItem[], options?: { skipConfirm?: boolean }) {
    if (targets.length === 0) return;
    const favorites = targets.filter((item) => item.favorite).length;
    if (!options?.skipConfirm || favorites > 0) {
      const many = targets.length > 1;
      const ok = await confirm({
        title: many ? `Delete ${targets.length} items?` : "Delete this item?",
        description:
          `The audio ${many ? "files are" : "file is"} removed from disk and can't be recovered.` +
          (favorites
            ? `\n${favorites === 1 ? "1 is a favorite" : `${favorites} are favorites`}.`
            : ""),
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
    }
    const results = await Promise.allSettled(
      targets.map((item) => (item.asset ? api.deleteAsset(item.id) : api.deleteGeneration(item.id))),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    const done = targets.length - failed;
    if (done > 0) toast(`Deleted ${done} item${done === 1 ? "" : "s"}`, "success");
    if (failed > 0) toast(`${failed} could not be deleted`, "error");
    setSelected(new Set());
    await refresh();
  }

  async function setFavorite(ids: string[], favorite: boolean) {
    const before = generations;
    setGenerations((current) => current.map((g) => (ids.includes(g.id) ? { ...g, favorite } : g)));
    try {
      await Promise.all(ids.map((id) => api.setFavorite(id, favorite)));
    } catch (error) {
      setGenerations(before);
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

  async function exportItems(targets: LibraryItem[]) {
    const exportable = targets.filter((i) => i.generation?.audio_path && i.status === "ready");
    if (exportable.length === 0) return;
    let exported = 0;
    let last = "";
    for (const item of exportable) {
      try {
        // One at a time: each is an ffmpeg run, and a long list shouldn't queue them all at once.
        const asset = await api.convert({
          generation_id: item.id,
          output_format: preferences.default_output_format,
        });
        exported += 1;
        last = asset.name;
      } catch (error) {
        toast((error as Error).message, "error");
      }
    }
    if (exported > 0) {
      toast(exported === 1 ? `Exported ${last}` : `Exported ${exported} files`, "success");
      await refresh();
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", "success");
    } catch {
      toast("Couldn't copy to the clipboard", "error");
    }
  }

  function toggleIn(setter: typeof setCollapsed, key: string) {
    setter((current) => {
      const copy = new Set(current);
      if (copy.has(key)) copy.delete(key);
      else copy.add(key);
      return copy;
    });
  }

  // Keyboard: Ctrl/Cmd+A selects everything shown, Esc clears, Delete removes.
  const keyState = useRef({ visibleIds, selectedItems, deleteItems });
  keyState.current = { visibleIds, selectedItems, deleteItems };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      ) {
        return;
      }
      const { visibleIds: ids, selectedItems: chosen, deleteItems: remove } = keyState.current;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelected(new Set(ids));
      } else if (event.key === "Escape") {
        setSelected(new Set());
      } else if ((event.key === "Delete" || event.key === "Backspace") && chosen.length > 0) {
        event.preventDefault();
        void remove(chosen);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- rendering -----------------------------------------------------------
  function renderRow(item: LibraryItem) {
    const common = {
      selected: selected.has(item.id),
      onSelectedChange: (next: boolean, range: boolean) => select(item.id, next, range),
    };

    if (item.asset) {
      const asset = item.asset;
      return (
        <TrackRow
          key={item.id}
          {...common}
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
                onClick={() => deleteItems([item], { skipConfirm: true })}
              >
                <TrashIcon />
              </IconButton>
            </>
          }
        />
      );
    }

    const g = item.generation!;
    const done = g.status === "completed" && !!g.audio_path;
    const active = item.status === "active";
    const open = expanded.has(item.id);
    const textLabel = g.kind === "speech" ? "script" : "prompt";
    const profileExists = !!g.profile_id && voiceNames.has(g.profile_id);

    return (
      <TrackRow
        key={item.id}
        {...common}
        busy={active}
        leading={tab === "all" ? <KindIcon kind={g.kind} /> : undefined}
        title={truncate(g.text, 120)}
        track={
          done
            ? {
                id: g.id,
                path: g.audio_path!,
                title: truncate(g.text, 120),
                subtitle: item.voice ?? undefined,
              }
            : undefined
        }
        badge={
          item.status === "failed" ? (
            <Badge tone="bad">failed</Badge>
          ) : active ? (
            <Badge tone="busy">{g.status}</Badge>
          ) : undefined
        }
        meta={
          item.status === "failed" ? (
            <span className="text-coral-red">{g.error ?? "Generation failed"}</span>
          ) : (
            [
              item.voice,
              g.kind !== "speech" ? item.engine : null,
              g.duration_seconds != null && formatDuration(g.duration_seconds),
              g.format?.toUpperCase(),
              formatWhen(g.created_at),
            ]
              .filter(Boolean)
              .join(" · ")
          )
        }
        detail={open ? <GenerationDetails generation={g} voice={item.voice} /> : undefined}
        actions={
          <>
            {done && (
              <IconButton
                label={item.favorite ? "Remove from favorites" : "Add to favorites"}
                aria-pressed={item.favorite}
                onClick={() => setFavorite([g.id], !item.favorite)}
                className={cn(item.favorite && "text-warning hover:text-warning")}
              >
                <Star className={cn("size-4", item.favorite && "fill-current")} />
              </IconButton>
            )}
            <IconButton
              label={open ? "Hide details" : "Show details"}
              aria-expanded={open}
              onClick={() => toggleIn(setExpanded, item.id)}
            >
              {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="More actions"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => copyText(g.text)}>
                  <Copy /> Copy {textLabel}
                </DropdownMenuItem>
                {g.kind === "speech" && profileExists && (
                  <DropdownMenuItem
                    onSelect={() =>
                      onOpenInGenerate({ kind: "script", profileId: g.profile_id!, text: g.text })
                    }
                  >
                    <UserRound /> Use voice &amp; script
                  </DropdownMenuItem>
                )}
                {g.kind !== "speech" && done && g.duration_seconds ? (
                  <DropdownMenuItem
                    onSelect={() =>
                      onOpenInGenerate({
                        kind: "clip",
                        source: {
                          id: g.id,
                          kind: g.kind as "music" | "sfx",
                          text: g.text,
                          seconds: g.duration_seconds!,
                        },
                      })
                    }
                  >
                    <Pencil /> Edit clip…
                  </DropdownMenuItem>
                ) : null}
                {done && (
                  <>
                    <DropdownMenuItem onSelect={() => reveal(g.audio_path!)}>
                      <FolderIcon /> Show file
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => exportItems([item])}>
                      <DownloadIcon /> Export as {preferences.default_output_format.toUpperCase()}
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => deleteItems([item], { skipConfirm: true })}
                >
                  <TrashIcon /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
    );
  }

  const exportableSelected = selectedItems.filter((i) => i.generation?.audio_path && i.status === "ready");
  const starrable = selectedItems.filter((i) => i.generation && i.status === "ready");
  const unstarring = starrable.length > 0 && starrable.every((i) => i.favorite);
  const groupedAndCollapsible = group !== "none" && groups.length > 0;
  const allCollapsed = groupedAndCollapsible && groups.every((g) => collapsed.has(groupKey(g.key)));

  return (
    <>
      <PageHeader
        title="Library"
        description={
          visible.length === 0
            ? "Nothing to show"
            : `${visible.length} ${visible.length === 1 ? "item" : "items"} · ${formatTotal(totalSeconds)} of audio`
        }
      />

      <div className="sticky top-0 z-10 -mx-1 space-y-3 bg-background px-1 pb-3">
        {/* What it is: the primary split. */}
        <Tabs value={tab} onValueChange={(next) => changeTab(next as TypeTab)} className="gap-0">
          <div className="border-b pb-1">
            <TabsList variant="line" className="h-9 w-full justify-start gap-5 p-0">
              {TABS.map((t) => (
                <TabsTrigger key={t} value={t} className="flex-none gap-1.5 px-0.5">
                  {TAB_LABEL[t]}
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">
                    {tabCounts[t]}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder={SEARCH_PLACEHOLDER[tab]}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {tab === "speech" && (
            <OptionSelect
              value={voiceId || "__all"}
              onChange={(value) => setVoiceId(value === "__all" ? "" : value)}
              className="w-40"
              options={[
                { value: "__all", label: "All voices" },
                ...profiles.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          )}

          {!onExports && (
            <Toggle
              variant="outline"
              size="sm"
              pressed={favoritesOnly}
              onPressedChange={setFavoritesOnly}
              aria-label="Favorites only"
              className="h-9 gap-1.5 px-3 text-[13px] font-normal text-muted-foreground data-[state=on]:text-warning"
            >
              <Star className={cn("size-4", favoritesOnly && "fill-current")} />
              Favorites
            </Toggle>
          )}

          <OptionSelect
            value={group}
            onChange={(value) => setGroupChoice(value as GroupBy)}
            className="w-40"
            options={groupChoices.map((g) => ({
              value: g,
              label: g === "none" ? GROUP_LABEL[g] : `Group by ${GROUP_LABEL[g].toLowerCase()}`,
            }))}
          />
          <OptionSelect
            value={sort}
            onChange={(value) => setSort(value as SortBy)}
            className="w-36"
            options={SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))}
          />
        </div>

        {/* Where it stands: a separate, quieter component. Files have no status. */}
        {!onExports && (
          <LibraryStatus
            counts={statusCounts}
            value={status}
            onChange={setStatus}
            onClearFailed={() =>
              deleteItems(items.filter((i) => matches(i, filters, ["status"]) && i.status === "failed"))
            }
          />
        )}
      </div>

      <div className="border-y">
        <div className="flex h-11 items-center gap-3 border-b px-2">
          <Checkbox
            checked={allSelected ? true : selectedItems.length > 0 ? "indeterminate" : false}
            disabled={visible.length === 0}
            onCheckedChange={(next) => setSelected(next === true ? new Set(visibleIds) : new Set())}
            aria-label="Select all"
          />
          {selectedItems.length > 0 ? (
            <>
              <span className="text-[13px] text-foreground">{selectedItems.length} selected</span>
              <div className="ml-auto flex items-center gap-2">
                {starrable.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setFavorite(starrable.map((i) => i.id), !unstarring)}
                  >
                    <Star className={cn(unstarring && "fill-current")} />
                    {unstarring ? "Unfavorite" : "Favorite"}
                  </Button>
                )}
                {exportableSelected.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => exportItems(exportableSelected)}>
                    <DownloadIcon />
                    Export {preferences.default_output_format.toUpperCase()}
                  </Button>
                )}
                <Button size="sm" variant="destructive" onClick={() => deleteItems(selectedItems)}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            </>
          ) : (
            <>
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {COLUMN_LABEL[tab]}
              </span>
              {groupedAndCollapsible && groups.length > 1 && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto text-muted-foreground"
                  onClick={() =>
                    setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => groupKey(g.key))))
                  }
                >
                  {allCollapsed ? "Expand all" : "Collapse all"}
                </Button>
              )}
            </>
          )}
        </div>

        {visible.length === 0 ? (
          <Empty>
            {!loaded ? (
              "Loading your library…"
            ) : items.length === 0 ? (
              "Nothing generated yet — the Generate tab is where audio starts."
            ) : anyFilter ? (
              <>
                {favoritesOnly && !query && status === "all"
                  ? "No favorites here yet — star a clip with the ★ to keep it handy."
                  : "Nothing matches those filters."}
                <span className="mt-3 block">
                  <Button size="sm" variant="outline" onClick={clearFilters}>
                    <FilterX /> Clear filters
                  </Button>
                </span>
              </>
            ) : onExports ? (
              "No exports yet. Use “Export” on any finished clip."
            ) : (
              `No ${TAB_LABEL[tab].toLowerCase()} yet.`
            )}
          </Empty>
        ) : (
          groups.map((g) => {
            const grouped = group !== "none";
            const closed = grouped && collapsed.has(groupKey(g.key));
            const ids = g.items.map((i) => i.id);
            const picked = ids.filter((id) => selected.has(id)).length;
            return (
              <section key={g.key}>
                {grouped && (
                  <div className="flex h-9 items-center gap-3 border-b bg-muted/30 px-2">
                    <Checkbox
                      checked={picked === ids.length ? true : picked > 0 ? "indeterminate" : false}
                      onCheckedChange={(next) => selectGroup(ids, next === true)}
                      aria-label={`Select all in ${g.label}`}
                    />
                    <button
                      type="button"
                      aria-expanded={!closed}
                      onClick={() => toggleIn(setCollapsed, groupKey(g.key))}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      {closed ? (
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate text-[13px] font-medium text-foreground">{g.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {g.items.length} · {formatTotal(g.seconds)}
                      </span>
                    </button>
                  </div>
                )}
                {!closed && <div className="divide-y">{g.items.map(renderRow)}</div>}
              </section>
            );
          })
        )}
      </div>
    </>
  );
}
