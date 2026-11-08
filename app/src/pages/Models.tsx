import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Download, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import type { AudioEngine, Model, Models } from "../lib/types";
import { formatBytes } from "../lib/format";
import { useToast } from "../components/Toaster";
import { ExternalLink } from "../components/ExternalLink";
import { useConfirm } from "../components/Confirm";
import { EnginePanel } from "../components/EnginePanel";
import { HfTokenField } from "../components/HfTokenField";
import { Badge, Empty, Notice, PageHeader, Section, cx } from "../components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/** How often to re-poll while at least one download is in flight. */
const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 15000;

export function ModelsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<Models | null>(null);
  const [engines, setEngines] = useState<AudioEngine[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null until the token field has asked the backend.
  const [tokenReady, setTokenReady] = useState<boolean | null>(null);

  /** Reload models and engines together; throws while the backend is down. */
  const reload = useCallback(async () => {
    const [models, audioEngines] = await Promise.all([api.listModels(), api.listAudioEngines()]);
    setData(models);
    setEngines(audioEngines);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      await reload();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [reload]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const downloading = useMemo(
    () =>
      (data?.models ?? []).some(
        (model) => model.job?.state === "downloading" || model.job?.state === "queued",
      ),
    [data],
  );

  // A download moves bytes every second; an idle page does not need that.
  useEffect(() => {
    const timer = window.setInterval(
      () => void refresh(),
      downloading ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [downloading, refresh]);

  /** Run a mutation that answers with fresh page state. */
  async function act(id: string, action: () => Promise<Models>, done?: string) {
    setBusy(id);
    try {
      setData(await action());
      if (done) toast(done, "success");
    } catch (caught) {
      toast((caught as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function remove(model: Model) {
    const size = model.size_bytes ? ` (${formatBytes(model.size_bytes)})` : "";
    const ok = await confirm({
      title: `Delete “${model.title}”?`,
      description:
        `The downloaded files${size} are removed.\n\n` +
        "Voice profiles that use it are kept — you would need to download it " +
        "again before generating with them.",
      confirmLabel: "Delete files",
      destructive: true,
    });
    if (!ok) return;
    await act(model.id, () => api.deleteModel(model.id), `${model.title} removed`);
  }

  if (error && !data) {
    return (
      <>
        <PageHeader title="Models" />
        <Empty>{error}</Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Models"
        description="Download and choose the models VoiceCraft generates with. Downloads are the only thing in the app that uses the network."
      />

      <div className="space-y-10">
        {data && <Storage data={data} onChange={setData} />}

        {data?.models.some((model) => model.gated) && (
          <Section
            title="Hugging Face access"
            description="Some models (Stable Audio 3) are gated: Hugging Face serves them only to an account that accepted the terms."
          >
            <HfTokenField onChange={(status) => setTokenReady(status.configured)} />
          </Section>
        )}

        {data?.categories.map((category) => {
          const models = data.models.filter((model) => model.category === category.id);
          if (models.length === 0) return null;
          return (
            <Section key={category.id} title={category.label}>
              <EnginePanel
                engines={engines.filter((engine) => engine.kind === category.id)}
                onChanged={reload}
              />
              <ul className="divide-y border-y">
                {models.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    busy={busy === model.id}
                    open={expanded === model.id}
                    needsToken={model.gated && tokenReady === false}
                    onToggle={() =>
                      setExpanded((current) => (current === model.id ? null : model.id))
                    }
                    onDownload={() => act(model.id, () => api.downloadModel(model.id))}
                    onCancel={() => act(model.id, () => api.cancelModelDownload(model.id))}
                    onSelect={() =>
                      act(
                        model.id,
                        () => api.selectModel(model.id),
                        `${model.title} is now the ${model.engine} model`,
                      )
                    }
                    onDelete={() => remove(model)}
                  />
                ))}
              </ul>
            </Section>
          );
        })}
      </div>
    </>
  );
}

/** Where weights live: the shared Hugging Face cache, not the app data dir. */
function Storage({
  data,
  onChange,
}: {
  data: Models;
  onChange: (models: Models) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(data.models_dir);
  const [busy, setBusy] = useState(false);

  async function save(next: string) {
    setBusy(true);
    try {
      onChange(await api.setModelsDir(next));
      setEditing(false);
      toast(
        next
          ? "Storage location changed. Existing downloads were left where they are."
          : "Storage location reset to the Hugging Face default.",
        "success",
      );
    } catch (caught) {
      toast((caught as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Storage location"
      description={`${formatBytes(data.used_bytes)} used${
        data.free_bytes != null ? ` · ${formatBytes(data.free_bytes)} free` : ""
      }`}
      actions={
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              api.openModelsDir().catch((caught) => toast((caught as Error).message, "error"))
            }
          >
            Open
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((current) => !current)}>
            {editing ? "Cancel" : "Change"}
          </Button>
        </div>
      }
    >
      <p className="truncate font-mono text-xs text-foreground" title={data.models_dir}>
        {data.models_dir}
      </p>

      {editing && (
        <form
          className="space-y-2 pt-1"
          onSubmit={(event) => {
            event.preventDefault();
            void save(path.trim());
          }}
        >
          <div className="flex gap-2">
            <Input
              autoFocus
              value={path}
              spellCheck={false}
              placeholder="D:\models\huggingface"
              onChange={(event) => setPath(event.target.value)}
            />
            <Button type="submit" disabled={busy}>
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setPath("");
                void save("");
              }}
            >
              Reset
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            This is the shared Hugging Face cache, so other tools on this machine
            read it too. Nothing is copied — models already downloaded to the old
            folder stay there, and models already present in the new one are picked
            up immediately.
          </p>
        </form>
      )}
    </Section>
  );
}

function ModelRow({
  model,
  busy,
  open,
  needsToken,
  onToggle,
  onDownload,
  onCancel,
  onSelect,
  onDelete,
}: {
  model: Model;
  busy: boolean;
  open: boolean;
  /** Gated, and no Hugging Face token is available yet. */
  needsToken: boolean;
  onToggle: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const job = model.job;
  const running = job?.state === "downloading" || job?.state === "queued";

  return (
    <li>
      <Collapsible open={open} onOpenChange={onToggle}>
        <CollapsibleTrigger className="flex w-full items-center gap-3 px-2 py-3 text-left transition-colors hover:bg-accent/40">
          <StateIcon model={model} running={Boolean(running)} />

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{model.title}</span>
              {model.active && <Badge tone="good">in use</Badge>}
              {!model.engine_available && <Badge tone="warn">engine missing</Badge>}
              <LicenseBadge model={model} />
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {model.summary}
            </span>
          </span>

          <span className="shrink-0 text-xs text-muted-foreground">
            {running
              ? progressLabel(job!)
              : model.downloaded
                ? formatBytes(model.size_bytes)
                : `${formatBytes(model.download_estimate_bytes)} download`}
          </span>
          <ChevronRight
            className={cx(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>

        {running && job && (
          <div className="px-2 pb-3">
            {/* The published size is an estimate, so clamp rather than overflow the bar. */}
            <Progress
              className="h-1"
              value={
                job.total_bytes ? Math.min(100, (job.downloaded_bytes / job.total_bytes) * 100) : 0
              }
            />
          </div>
        )}

        {job?.state === "failed" && job.error && (
          <div className="px-2 pb-3">
            <Notice tone="bad">{job.error}</Notice>
          </div>
        )}

        <CollapsibleContent>
          <div className="space-y-4 border-t bg-card/50 py-4 pl-11 pr-2">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
              <Detail label="Repository">
                <span className="font-mono text-foreground">{model.repo_id}</span>
              </Detail>
              <Detail label="Engine">{model.engine}</Detail>
              <Detail label="Voice cloning">
                {model.clones_voices ? "yes" : "preset voices only"}
              </Detail>
              <Detail label="Hardware">
                {model.needs_gpu ? "NVIDIA GPU recommended" : "runs on CPU"}
              </Detail>
              <Detail label="Languages">{model.languages.join(", ") || "—"}</Detail>
              <Detail label="On disk">
                {model.downloaded ? formatBytes(model.size_bytes) : "not downloaded"}
              </Detail>
            </dl>

            <LicenseLine model={model} />

            {model.shared_with.length > 0 && (
              <p className="text-xs text-muted-foreground">
                This entry shares its files with another one, so deleting either removes both.
              </p>
            )}

            {model.notes.length > 0 && (
              <ul className="space-y-1">
                {model.notes.map((note) => (
                  <li key={note} className="flex gap-2 text-xs text-muted-foreground">
                    <span aria-hidden="true">·</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}

            {model.path && (
              <p
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={model.path}
              >
                {model.path}
              </p>
            )}

            <Separator />

            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
                  Cancel download
                </Button>
              ) : model.downloaded ? (
                <>
                  {!model.active && (
                    <Button size="sm" disabled={busy} onClick={onSelect}>
                      Use this model
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-coral-red hover:text-coral-red"
                    disabled={busy}
                    onClick={onDelete}
                  >
                    Delete files
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" disabled={busy || needsToken} onClick={onDownload}>
                    Download
                  </Button>
                  {needsToken && (
                    <span className="text-xs text-warning">
                      Add your Hugging Face token under “Hugging Face access” first.
                    </span>
                  )}
                </>
              )}

              {model.active && model.downloaded && (
                <span className="text-xs text-muted-foreground">
                  Generations with the {model.engine} engine use this checkpoint.
                </span>
              )}
              {!model.engine_available && (
                <span className="text-xs text-warning">
                  {model.optional_engine
                    ? `The ${model.engine} engine is not installed — install it in the panel above this list.`
                    : `The ${model.engine} engine is not installed — run Engine setup from the sidebar.`}
                </span>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function progressLabel(job: {
  state: string;
  downloaded_bytes: number;
  total_bytes: number;
}): string {
  if (job.state === "queued") return "queued…";
  const percent = job.total_bytes
    ? Math.min(99, Math.floor((job.downloaded_bytes / job.total_bytes) * 100))
    : 0;
  return `${percent}% · ${formatBytes(job.downloaded_bytes)}`;
}

function StateIcon({ model, running }: { model: Model; running: boolean }) {
  const style = running
    ? "border-primary/40 text-primary"
    : model.downloaded
      ? "border-pulse-green/50 bg-pulse-green/10 text-pulse-green"
      : "text-muted-foreground";
  return (
    <span
      aria-hidden="true"
      className={cx("flex size-6 shrink-0 items-center justify-center rounded-full border", style)}
    >
      {running ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : model.downloaded ? (
        <Check className="size-3.5" />
      ) : (
        <Download className="size-3.5" />
      )}
    </span>
  );
}

/** License tier chip (docs/audio-roadmap.md §1.1): open stays quiet, the rest speak up. */
function LicenseBadge({ model }: { model: Model }) {
  if (model.license_tier === "conditional") {
    return <Badge tone="warn">{model.license_name ?? "Conditional license"}</Badge>;
  }
  if (model.license_tier === "noncommercial") {
    return <Badge tone="bad">NC · {model.license_name ?? "non-commercial"}</Badge>;
  }
  return model.license_name ? <Badge>{model.license_name}</Badge> : null;
}

const TIER_TEXT: Record<Model["license_tier"], string | null> = {
  open: null,
  conditional:
    "Community license: free use may be capped (for example by revenue) and may require attribution. Read the terms before using output commercially.",
  noncommercial: "Output from this model can't be used commercially.",
};

/** License name, what the tier means, and where to read the terms. */
function LicenseLine({ model }: { model: Model }) {
  const text = TIER_TEXT[model.license_tier];
  if (!model.license_name && !model.license_url && !text && !model.gated) return null;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        <span className="uppercase tracking-wide text-[10px]">License</span>{" "}
        <span className="text-foreground">{model.license_name ?? "see repository"}</span>
        {model.gated && " · gated download (needs a Hugging Face token)"}
      </p>
      {text && <p>{text}</p>}
      {model.license_url && (
        <p className="select-text break-all font-mono text-[11px]">
          <ExternalLink href={model.license_url} className="text-muted-foreground" />
        </p>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-foreground">{children}</dd>
    </div>
  );
}
