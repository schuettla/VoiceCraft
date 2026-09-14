import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { isTauri, listen, setupApi, type SetupStatus, type SetupStep } from "../lib/tauri";
import { Button, cx, Panel } from "../components/ui";

type StepId = SetupStep["step"];
type StepState = SetupStep["state"] | "pending";

const STEPS: { id: StepId; label: string; detail: string }[] = [
  { id: "python", label: "Install Python", detail: "A private Python 3.11 — nothing is installed system-wide" },
  { id: "runtime", label: "Create the runtime", detail: "A private environment under your app data folder" },
  { id: "ffmpeg", label: "Set up ffmpeg", detail: "Downloaded if it isn't already on this machine" },
  { id: "torch", label: "Install PyTorch", detail: "CUDA on NVIDIA, Metal on Apple Silicon — a large download" },
  { id: "engines", label: "Install the engines", detail: "Qwen3-TTS, Kokoro, and the backend packages" },
  { id: "model", label: "Download the voice model", detail: "Kokoro weights, ~330 MB, cached for offline use" },
];

/** First-run onboarding: installs everything the app needs to actually run. */
export function SetupPage({ onReady }: { onReady: () => void }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [states, setStates] = useState<Record<StepId, StepState>>({
    python: "pending",
    runtime: "pending",
    ffmpeg: "pending",
    torch: "pending",
    engines: "pending",
    model: "pending",
  });
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceCpu, setForceCpu] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await setupApi.status());
    } catch {
      /* browser preview — nothing to report */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [
      listen<string>("setup:log", (line) =>
        // Keep the tail only; a torch install prints thousands of lines.
        setLog((current) => [...current.slice(-400), line]),
      ),
      listen<SetupStep>("setup:step", (step) =>
        setStates((current) => ({ ...current, [step.step]: step.state })),
      ),
      listen<void>("setup:done", async () => {
        setRunning(false);
        await refresh();
        // The backend is up by the time this fires; confirm before switching,
        // and give it one explicit nudge if it isn't answering yet.
        for (let attempt = 0; attempt < 25; attempt += 1) {
          try {
            await api.health();
            onReady();
            return;
          } catch {
            if (attempt === 8) {
              await setupApi.startBackend().catch(() => {});
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        setError(
          "The engine is installed, but the backend did not answer. " +
            "Use “Skip — start the app” to retry, or check the log above.",
        );
      }),
      listen<string>("setup:failed", (message) => {
        setRunning(false);
        setError(message);
      }),
    ];
    return () => {
      unlisteners.forEach((promise) => void promise.then((off) => off()));
    };
  }, [onReady, refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  async function start() {
    setError(null);
    setLog([]);
    setRunning(true);
    setStates({
      python: "pending",
      runtime: "pending",
      ffmpeg: "pending",
      torch: "pending",
      engines: "pending",
      model: "pending",
    });
    try {
      await setupApi.install(forceCpu);
    } catch (caught) {
      setRunning(false);
      setError((caught as Error).message);
    }
  }

  /** Start the backend and only enter the studio once it answers. */
  async function startBackendAndEnter() {
    setError(null);
    try {
      await setupApi.startBackend();
    } catch (caught) {
      setError((caught as Error).message);
      return;
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        await api.health();
        onReady();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    setError("The backend still isn't answering. Re-run the install to repair it.");
  }

  const gpu = status?.gpu;
  const isMac = status?.platform === "macos";
  const alreadyInstalled = Boolean(status?.engines);

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-5 py-6">
      <div className="text-center">
        <h1 className="text-2xl font-medium text-white">
          Welcome to Voice<span className="text-accent">Craft</span>
        </h1>
        <p className="mt-2 text-sm text-ink-400">
          One-time setup installs the speech engine on this machine. Everything
          stays local afterwards — the only network use is this download.
        </p>
      </div>

      <Panel title="This machine">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Row label="Graphics">
            {isMac ? (
              <span className="text-emerald-400">Apple Silicon — Metal (MPS)</span>
            ) : gpu ? (
              <span className="text-emerald-400">{gpu} — CUDA build</span>
            ) : (
              <span className="text-amber-400">
                No NVIDIA GPU detected — CPU build (slower)
              </span>
            )}
          </Row>
          <Row label="Python">
            {status?.python_version ? (
              <span className="text-emerald-400">{status.python_version}</span>
            ) : (
              <span className="text-amber-400">Installed during setup</span>
            )}
          </Row>
          <Row label="ffmpeg">
            {status?.ffmpeg ? (
              <span className="text-emerald-400">found</span>
            ) : (
              <span className="text-amber-400">Downloaded during setup</span>
            )}
          </Row>
          <Row label="Install location">
            <span className="truncate text-ink-400" title={status?.data_dir}>
              {status?.data_dir ?? "…"}
            </span>
          </Row>
        </dl>
      </Panel>

      <Panel
        title={alreadyInstalled ? "Engine installed" : "Install the engine"}
        subtitle={
          alreadyInstalled
            ? "Re-run this if something is broken or you changed GPUs."
            : "Roughly 2–3 GB with CUDA, a few hundred MB on CPU."
        }
      >
        <ol className="space-y-2">
          {STEPS.map((item) => (
            <li key={item.id} className="flex items-start gap-3">
              <StepDot state={states[item.id]} />
              <div className="min-w-0">
                <p
                  className={cx(
                    "text-sm",
                    states[item.id] === "done" ? "text-white" : "text-ink-200",
                  )}
                >
                  {item.label}
                </p>
                <p className="text-xs text-ink-400">{item.detail}</p>
              </div>
            </li>
          ))}
        </ol>

        {!isMac && (
          <label className="mt-4 flex items-center gap-2 text-xs text-ink-400">
            <input
              type="checkbox"
              checked={forceCpu}
              disabled={running}
              onChange={(e) => setForceCpu(e.target.checked)}
              className="accent-accent"
            />
            Force the CPU build even if a GPU is present
          </label>
        )}

        {error && (
          <p className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="primary"
            disabled={running || !isTauri()}
            onClick={start}
          >
            {running
              ? "Installing…"
              : alreadyInstalled
                ? "Re-install engine"
                : "Install and continue"}
          </Button>
          {alreadyInstalled && !running && (
            <Button onClick={startBackendAndEnter}>Skip — start the app</Button>
          )}
          {running && (
            <span className="text-xs text-ink-400">
              Large downloads — you can leave this running.
            </span>
          )}
        </div>
      </Panel>

      {log.length > 0 && (
        <Panel title="Progress log">
          <div
            ref={logRef}
            className="max-h-64 overflow-y-auto rounded-lg bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-400"
          >
            {log.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 truncate">{children}</dd>
    </div>
  );
}

function StepDot({ state }: { state: StepState }) {
  const styles: Record<StepState, string> = {
    pending: "border-ink-600 text-ink-600",
    running: "border-sky-500 text-sky-400 animate-pulse",
    done: "border-emerald-600 bg-emerald-600/20 text-emerald-400",
    failed: "border-red-700 text-red-400",
    skipped: "border-amber-700 text-amber-400",
  };
  const glyph: Record<StepState, string> = {
    pending: "○",
    running: "◐",
    done: "✓",
    failed: "✕",
    skipped: "!",
  };
  return (
    <span
      className={cx(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
        styles[state],
      )}
    >
      {glyph[state]}
    </span>
  );
}
