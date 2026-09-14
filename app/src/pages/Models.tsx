import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Model, Models } from "../lib/types";
import { formatBytes } from "../lib/format";
import { useToast } from "../components/Toaster";
import { Badge, Button, cx, Empty, Input, Panel } from "../components/ui";

/** How often to re-poll while at least one download is in flight. */
const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 15000;

export function ModelsPage() {
  const toast = useToast();
  const [data, setData] = useState<Models | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api.listModels());
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);

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
    if (
      !window.confirm(
        `Delete the downloaded files for “${model.title}”${size}?\n\n` +
          "Voice profiles that use it are kept — you would need to download it " +
          "again before generating with them.",
      )
    ) {
      return;
    }
    await act(model.id, () => api.deleteModel(model.id), `${model.title} removed`);
  }

  if (error && !data) {
    return (
      <div className="mx-auto max-w-4xl">
        <Panel title="Models">
          <Empty>{error}</Empty>
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <div>
        <h1 className="text-lg font-medium text-white">Models</h1>
        <p className="mt-1 text-sm text-ink-400">
          Download and choose the models VoiceCraft generates with. Downloads are
          the only thing in the app that uses the network.
        </p>
      </div>

      {data && <Storage data={data} onChange={setData} />}

      {data?.categories.map((category) => {
        const models = data.models.filter((model) => model.category === category.id);
        if (models.length === 0) return null;
        return (
          <section key={category.id}>
            <h2 className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wider text-ink-400">
              {category.label}
            </h2>
            <ul className="overflow-hidden rounded-xl border border-ink-700 bg-ink-900/70">
              {models.map((model, index) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  first={index === 0}
                  busy={busy === model.id}
                  open={expanded === model.id}
                  onToggle={() =>
                    setExpanded((current) => (current === model.id ? null : model.id))
                  }
                  onDownload={() =>
                    act(model.id, () => api.downloadModel(model.id))
                  }
                  onCancel={() =>
                    act(model.id, () => api.cancelModelDownload(model.id))
                  }
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
          </section>
        );
      })}
    </div>
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
    <div className="rounded-xl border border-ink-700 bg-ink-900/70 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
            Storage location
          </p>
          <p className="mt-1 truncate font-mono text-xs text-ink-200" title={data.models_dir}>
            {data.models_dir}
          </p>
          <p className="mt-1 text-xs text-ink-400">
            {formatBytes(data.used_bytes)} used
            {data.free_bytes != null && ` · ${formatBytes(data.free_bytes)} free`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            onClick={() =>
              api.openModelsDir().catch((caught) => toast((caught as Error).message, "error"))
            }
          >
            Open
          </Button>
          <Button size="sm" onClick={() => setEditing((current) => !current)}>
            {editing ? "Cancel" : "Change"}
          </Button>
        </div>
      </div>

      {editing && (
        <form
          className="mt-3 border-t border-ink-700 pt-3"
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
            <Button type="submit" variant="primary" disabled={busy}>
              Save
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setPath("");
                void save("");
              }}
            >
              Reset
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-400">
            This is the shared Hugging Face cache, so other tools on this machine
            read it too. Nothing is copied — models already downloaded to the old
            folder stay there, and models already present in the new one are picked
            up immediately.
          </p>
        </form>
      )}
    </div>
  );
}

function ModelRow({
  model,
  first,
  busy,
  open,
  onToggle,
  onDownload,
  onCancel,
  onSelect,
  onDelete,
}: {
  model: Model;
  first: boolean;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const job = model.job;
  const running = job?.state === "downloading" || job?.state === "queued";

  return (
    <li className={cx(!first && "border-t border-ink-700")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-ink-800/60"
      >
        <StateIcon model={model} running={Boolean(running)} />

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-white">{model.title}</span>
            {model.active && <Badge tone="good">in use</Badge>}
            {!model.engine_available && <Badge tone="warn">engine missing</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-400">
            {model.summary}
          </span>
        </span>

        <span className="shrink-0 text-xs text-ink-400">
          {running
            ? progressLabel(job!)
            : model.downloaded
              ? formatBytes(model.size_bytes)
              : `${formatBytes(model.download_estimate_bytes)} download`}
        </span>
        <Chevron open={open} />
      </button>

      {running && job && <Progress downloaded={job.downloaded_bytes} total={job.total_bytes} />}

      {job?.state === "failed" && job.error && (
        <p className="mx-4 mb-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {job.error}
        </p>
      )}

      {open && (
        <div className="border-t border-ink-700/60 bg-ink-950/40 px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
            <Detail label="Repository">
              <span className="font-mono text-ink-200">{model.repo_id}</span>
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

          {model.notes.length > 0 && (
            <ul className="mt-3 space-y-1">
              {model.notes.map((note) => (
                <li key={note} className="flex gap-2 text-xs text-ink-400">
                  <span aria-hidden="true">·</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          )}

          {model.path && (
            <p className="mt-3 truncate font-mono text-[11px] text-ink-400" title={model.path}>
              {model.path}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {running ? (
              <Button size="sm" disabled={busy} onClick={onCancel}>
                Cancel download
              </Button>
            ) : model.downloaded ? (
              <>
                {!model.active && (
                  <Button size="sm" variant="primary" disabled={busy} onClick={onSelect}>
                    Use this model
                  </Button>
                )}
                <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>
                  Delete files
                </Button>
              </>
            ) : (
              <Button size="sm" variant="primary" disabled={busy} onClick={onDownload}>
                Download
              </Button>
            )}

            {model.active && model.downloaded && (
              <span className="text-xs text-ink-400">
                Generations with the {model.engine} engine use this checkpoint.
              </span>
            )}
            {!model.engine_available && (
              <span className="text-xs text-amber-400">
                The {model.engine} engine is not installed — run Setup from the header.
              </span>
            )}
          </div>
        </div>
      )}
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

function Progress({ downloaded, total }: { downloaded: number; total: number }) {
  // The published size is an estimate, so clamp rather than overflow the bar.
  const percent = total ? Math.min(100, (downloaded / total) * 100) : 0;
  return (
    <div className="mx-4 mb-3 h-1 overflow-hidden rounded-full bg-ink-800">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function StateIcon({ model, running }: { model: Model; running: boolean }) {
  const style = running
    ? "border-sky-700 text-sky-400 animate-pulse"
    : model.downloaded
      ? "border-emerald-700 bg-emerald-600/15 text-emerald-400"
      : "border-ink-600 text-ink-400";
  return (
    <span
      aria-hidden="true"
      className={cx(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px]",
        style,
      )}
    >
      {running ? "◐" : model.downloaded ? "✓" : "↓"}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "shrink-0 text-ink-400 transition-transform",
        open && "rotate-90",
      )}
    >
      ›
    </span>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 truncate text-ink-200">{children}</dd>
    </div>
  );
}
