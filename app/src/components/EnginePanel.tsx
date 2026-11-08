import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AudioEngine } from "../lib/types";
import { formatBytes } from "../lib/format";
import { isTauri, listen, setupApi, type EngineState } from "../lib/tauri";
import { useConfirm } from "./Confirm";
import { useToast } from "./Toaster";
import { Badge, Notice } from "./common";
import { Button } from "@/components/ui/button";

/** Keep the tail only; a package install prints hundreds of lines. */
const LOG_LINES = 200;
/** The backend is restarted after a job; wait this long for it to answer again. */
const RESTART_WAIT_ATTEMPTS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Install / remove the Python packages of the music and sound-effect engines.
 *
 * Weights are separate (the model list below). An install stops the backend,
 * runs `uv pip install` in the shared runtime and starts the backend again, so
 * the log streams from the desktop shell, not from the API.
 */
export function EnginePanel({
  engines,
  onChanged,
}: {
  engines: AudioEngine[];
  /** Reload the page state. Must throw while the backend isn't answering. */
  onChanged: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [job, setJob] = useState<{ engine: string; action: "install" | "uninstall" } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [failure, setFailure] = useState<{ engine: string; message: string } | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const labels = useRef<Record<string, string>>({});
  labels.current = Object.fromEntries(engines.map((e) => [e.name, e.label]));

  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [
      listen<string>("setup:log", (line) =>
        setLog((current) => [...current.slice(-LOG_LINES), line]),
      ),
      listen<EngineState>("engine:state", (event) => {
        if (event.state === "running") {
          setJob({ engine: event.engine, action: event.action });
          return;
        }
        setJob(null);
        if (event.state === "failed") {
          setFailure({ engine: event.engine, message: event.detail ?? "The install failed." });
        } else {
          const label = labels.current[event.engine] ?? event.engine;
          toast(event.action === "install" ? `${label} installed` : `${label} removed`, "success");
        }
        void waitForBackend();
      }),
    ];
    return () => {
      unlisteners.forEach((promise) => void promise.then((off) => off()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  async function waitForBackend() {
    for (let attempt = 0; attempt < RESTART_WAIT_ATTEMPTS; attempt += 1) {
      try {
        await onChangedRef.current();
        return;
      } catch {
        await sleep(1000);
      }
    }
  }

  async function run(engine: AudioEngine, action: "install" | "uninstall") {
    // One package serves both Stable Audio 3 engines (music and sound effects),
    // so changing one changes the other. Say so before it happens.
    const shared = engine.name.startsWith("sa3_")
      ? "\n\nThis one package serves both Stable Audio 3 lists (music and sound effects), " +
        "so installing or removing it applies to both."
      : "";
    const ok =
      action === "install"
        ? await confirm({
            title: `Install ${engine.label}?`,
            description:
              `Downloads the Python packages ${engine.label} needs (a few hundred MB — ` +
              "PyTorch stays as it is) and restarts VoiceCraft's background engine. " +
              "Anything that is generating right now is interrupted.\n\n" +
              (engine.download_estimate_bytes
                ? `The model files (${formatBytes(engine.download_estimate_bytes)}) are a separate download in the list below.`
                : "The model files are a separate download in the list below.") +
              shared,
            confirmLabel: "Install engine",
          })
        : await confirm({
            title: `Remove ${engine.label}?`,
            description:
              "Removes the engine's package and restarts the background engine. " +
              "Downloaded model files stay until you delete them in the list below, " +
              "and clips you already generated are kept." +
              shared,
            confirmLabel: "Remove engine",
            destructive: true,
          });
    if (!ok) return;

    setFailure(null);
    setLog([]);
    setJob({ engine: engine.name, action });
    try {
      await (action === "install"
        ? setupApi.installEngine(engine.name)
        : setupApi.uninstallEngine(engine.name));
    } catch (caught) {
      setJob(null);
      setFailure({ engine: engine.name, message: (caught as Error).message });
    }
  }

  const desktop = isTauri();
  if (engines.length === 0) return null;

  return (
    <div className="mb-3 space-y-3">
      {engines.map((engine) => {
        const mine = job?.engine === engine.name;
        const otherBusy = job !== null && !mine;
        return (
          <div key={engine.name} className="rounded-md border bg-card/40 px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{engine.label}</span>
              <span className="text-xs text-muted-foreground">engine</span>
              {engine.installed ? (
                <Badge tone="good">installed</Badge>
              ) : (
                <Badge>not installed</Badge>
              )}
              {!engine.supported && <Badge tone="bad">can't run here</Badge>}

              <span className="ml-auto flex items-center gap-2">
                {mine ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    {job.action === "install" ? "Installing…" : "Removing…"}
                  </span>
                ) : engine.installed ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!desktop || job !== null}
                    onClick={() => run(engine, "uninstall")}
                  >
                    Remove engine
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!desktop || job !== null || !engine.supported}
                    onClick={() => run(engine, "install")}
                  >
                    Install engine
                  </Button>
                )}
              </span>
            </div>

            {!engine.supported && engine.unsupported_reason && (
              <p className="mt-2 text-xs text-muted-foreground">{engine.unsupported_reason}</p>
            )}
            {!desktop && (
              <p className="mt-2 text-xs text-muted-foreground">
                Installing engines is only available in the desktop app.
              </p>
            )}
            {otherBusy && (
              <p className="mt-2 text-xs text-muted-foreground">
                Another engine is being changed — one at a time.
              </p>
            )}

            {failure?.engine === engine.name && (
              <Notice tone="bad" className="mt-2">
                {failure.message}
              </Notice>
            )}

            {(mine || (failure?.engine === engine.name && log.length > 0)) && (
              <pre
                ref={mine ? logRef : undefined}
                className="mt-2 max-h-40 overflow-auto rounded bg-black/30 p-2 font-mono text-[11px] leading-snug text-muted-foreground"
              >
                {log.join("\n") || "Starting…"}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
