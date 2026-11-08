import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { isTauri, listen, setupApi, type SetupStatus, type SetupStep } from "../lib/tauri";
import { Check, Circle, CircleAlert, Loader2, X } from "lucide-react";
import { Notice, Section, cx } from "../components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

type StepId = SetupStep["step"];
type StepState = SetupStep["state"] | "pending";

const STEPS: { id: StepId; label: string; detail: string }[] = [
  { id: "python", label: "Install Python", detail: "A private Python 3.12 — nothing is installed system-wide" },
  { id: "runtime", label: "Create the runtime", detail: "A private environment under your app data folder" },
  { id: "ffmpeg", label: "Set up ffmpeg", detail: "Downloaded if it isn't already on this machine" },
  { id: "torch", label: "Install PyTorch", detail: "CUDA on NVIDIA, Metal on Apple Silicon — a large download" },
  { id: "engines", label: "Install the engines", detail: "Qwen3-TTS, KittenTTS, Kokoro, and the backend packages" },
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
  const needsUpdate = Boolean(status?.needs_runtime_update);
  // An outdated runtime can't be entered or "skipped": it has to be rebuilt first.
  const alreadyInstalled = Boolean(status?.engines) && !needsUpdate;

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-8 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Welcome to Voice<span className="text-primary">Craft</span>
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          One-time setup installs the speech engine on this machine. Everything
          stays local afterwards — the only network use is this download.
        </p>
      </div>

      <Section title="This machine">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Row label="Graphics">
            {isMac ? (
              <span className="text-pulse-green">Apple Silicon — Metal (MPS)</span>
            ) : gpu ? (
              <span className="text-pulse-green">{gpu} — CUDA build</span>
            ) : (
              <span className="text-warning">
                No NVIDIA GPU detected — CPU build (slower)
              </span>
            )}
          </Row>
          <Row label="Python">
            {status?.python_version ? (
              <span className="text-pulse-green">{status.python_version}</span>
            ) : (
              <span className="text-warning">Installed during setup</span>
            )}
          </Row>
          <Row label="ffmpeg">
            {status?.ffmpeg ? (
              <span className="text-pulse-green">found</span>
            ) : (
              <span className="text-warning">Downloaded during setup</span>
            )}
          </Row>
          <Row label="Install location">
            <span className="truncate text-muted-foreground" title={status?.data_dir}>
              {status?.data_dir ?? "…"}
            </span>
          </Row>
        </dl>
      </Section>

      <Separator />

      <Section
        title={
          needsUpdate
            ? "Update the engine runtime"
            : alreadyInstalled
              ? "Engine installed"
              : "Install the engine"
        }
        description={
          needsUpdate
            ? "VoiceCraft needs to update its engine runtime — a one-time download of roughly 2–3 GB with CUDA. Your voices, projects and downloaded models are kept."
            : alreadyInstalled
              ? "Re-run this if something is broken or you changed GPUs."
              : "Roughly 2–3 GB with CUDA, a few hundred MB on CPU."
        }
      >
        <ol className="space-y-3 py-1">
          {STEPS.map((item) => (
            <li key={item.id} className="flex items-start gap-3">
              <StepDot state={states[item.id]} />
              <div className="min-w-0">
                <p
                  className={cx(
                    "text-sm",
                    states[item.id] === "done" ? "text-white" : "text-foreground",
                  )}
                >
                  {item.label}
                </p>
                <p className="text-xs text-muted-foreground">{item.detail}</p>
              </div>
            </li>
          ))}
        </ol>

        {!isMac && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="force-cpu"
              checked={forceCpu}
              disabled={running}
              onCheckedChange={(next) => setForceCpu(next === true)}
            />
            <Label htmlFor="force-cpu" className="text-xs font-normal text-muted-foreground">
              Force the CPU build even if a GPU is present
            </Label>
          </div>
        )}

        {error && <Notice tone="bad">{error}</Notice>}

        <div className="flex items-center gap-3 pt-1">
          <Button disabled={running || !isTauri()} onClick={start}>
            {running && <Loader2 className="animate-spin" />}
            {running
              ? needsUpdate
                ? "Updating…"
                : "Installing…"
              : needsUpdate
                ? "Update and continue"
                : alreadyInstalled
                  ? "Re-install engine"
                  : "Install and continue"}
          </Button>
          {alreadyInstalled && !running && (
            <Button variant="outline" onClick={startBackendAndEnter}>
              Skip — start the app
            </Button>
          )}
          {running && (
            <span className="text-xs text-muted-foreground">
              Large downloads — you can leave this running.
            </span>
          )}
        </div>
      </Section>

      {log.length > 0 && (
        <Section title="Progress log">
          <div
            ref={logRef}
            className="max-h-64 overflow-y-auto rounded-md bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground ring-1 ring-border"
          >
            {log.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate">{children}</dd>
    </div>
  );
}

function StepDot({ state }: { state: StepState }) {
  const styles: Record<StepState, string> = {
    pending: "text-muted-foreground/50",
    running: "border-primary/50 text-primary",
    done: "border-pulse-green/50 bg-pulse-green/10 text-pulse-green",
    failed: "border-coral-red/50 text-coral-red",
    skipped: "border-warning/50 text-warning",
  };
  const glyph: Record<StepState, React.ReactNode> = {
    pending: <Circle className="size-3" />,
    running: <Loader2 className="size-3 animate-spin" />,
    done: <Check className="size-3" />,
    failed: <X className="size-3" />,
    skipped: <CircleAlert className="size-3" />,
  };
  return (
    <span
      className={cx(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
        styles[state],
      )}
    >
      {glyph[state]}
    </span>
  );
}
