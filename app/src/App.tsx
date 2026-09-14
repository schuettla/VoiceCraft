import { useCallback, useEffect, useState } from "react";
import { api } from "./lib/api";
import type { Health } from "./lib/types";
import { isTauri, setupApi } from "./lib/tauri";
import { Badge, cx } from "./components/ui";
import { ToastProvider } from "./components/Toaster";
import { AudioProvider } from "./components/AudioPlayer";
import { ProfilesPage } from "./pages/Profiles";
import { GeneratePage } from "./pages/Generate";
import { LibraryPage } from "./pages/Library";
import { EditPage } from "./pages/Edit";
import { ModelsPage } from "./pages/Models";
import { SettingsPage } from "./pages/Settings";
import { SetupPage } from "./pages/Setup";

type View = "profiles" | "generate" | "library" | "edit" | "models" | "settings";
type Phase = "booting" | "setup" | "ready";

const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: "profiles", label: "Profiles", hint: "Voices you can generate with" },
  { id: "generate", label: "Generate", hint: "Script → cloned-voice audio" },
  { id: "library", label: "Library", hint: "Everything generated, with exports" },
  { id: "edit", label: "Editor", hint: "Multitrack waveform editor" },
  { id: "models", label: "Models", hint: "Download and choose speech models" },
  { id: "settings", label: "Settings", hint: "Hardware, defaults, storage" },
];

export default function App() {
  const [phase, setPhase] = useState<Phase>("booting");
  const [view, setView] = useState<View>("profiles");
  const [health, setHealth] = useState<Health | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);

  /** Boot: wait for the backend; fall back to onboarding if it can't start. */
  const boot = useCallback(async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        setHealth(await api.health());
        setReachable(true);
        setPhase("ready");
        return;
      } catch {
        if (isTauri() && attempt === 1) {
          // The runtime may exist but the backend may not have been started.
          try {
            const status = await setupApi.status();
            if (!status.engines) {
              setPhase("setup");
              return;
            }
            await setupApi.startBackend();
          } catch {
            setPhase("setup");
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    // Browser preview has no setup wizard — show the app and its offline badge.
    setPhase(isTauri() ? "setup" : "ready");
    setReachable(false);
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const poll = useCallback(async () => {
    try {
      setHealth(await api.health());
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    if (phase !== "ready") return;
    const timer = window.setInterval(poll, 5000);
    return () => window.clearInterval(timer);
  }, [phase, poll]);

  if (phase === "booting") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <span className="text-lg font-medium tracking-tight text-white">
          Voice<span className="text-accent">Craft</span>
        </span>
        <span className="text-sm text-ink-400">Starting the speech engine…</span>
      </div>
    );
  }

  if (phase === "setup") {
    return (
      <ToastProvider>
        <main className="h-full overflow-y-auto px-5">
          <SetupPage
            onReady={() => {
              setPhase("ready");
              void poll();
            }}
          />
        </main>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <AudioProvider>
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-6 border-b border-ink-700 bg-ink-900 px-5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-medium tracking-tight text-white">
              Voice<span className="text-accent">Craft</span>
            </span>
            <span className="text-[11px] text-ink-400">local voice studio</span>
          </div>

          <nav className="flex gap-1">
            {VIEWS.map((item) => (
              <button
                key={item.id}
                title={item.hint}
                onClick={() => setView(item.id)}
                className={cx(
                  "rounded-md px-3 py-1.5 text-[13px] transition",
                  view === item.id
                    ? "bg-ink-800 text-white"
                    : "text-ink-400 hover:text-ink-200",
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <HealthIndicator health={health} reachable={reachable} />
            {isTauri() && (
              <button
                onClick={() => setPhase("setup")}
                className="rounded-md px-2 py-1 text-xs text-ink-400 hover:bg-ink-800 hover:text-ink-200"
                title="Re-run engine setup"
              >
                Setup
              </button>
            )}
          </div>
        </header>

        <main
          className={cx(
            "min-h-0 flex-1",
            // The editor manages its own internal scrolling and fixed layout;
            // the pb-28 other pages need to clear the fixed audio-player bar
            // just leaves unexplained dead space under it (and the bar sits
            // above the editor's own transport anyway).
            view === "edit" ? "overflow-hidden p-3" : "overflow-y-auto px-5 py-5 pb-28",
          )}
        >
          {view === "profiles" && <ProfilesPage health={health} />}
          {view === "generate" && <GeneratePage health={health} />}
          {view === "library" && <LibraryPage />}
          {view === "edit" && <EditPage />}
          {view === "models" && <ModelsPage />}
          {view === "settings" && (
            <SettingsPage onRunSetup={() => setPhase("setup")} />
          )}
        </main>
      </div>
      </AudioProvider>
    </ToastProvider>
  );
}

/** FR13: say what the backend is doing rather than showing a blind spinner. */
function HealthIndicator({
  health,
  reachable,
}: {
  health: Health | null;
  reachable: boolean | null;
}) {
  if (reachable === null) {
    return <Badge tone="busy">Connecting to backend…</Badge>;
  }
  if (!reachable) {
    return <Badge tone="bad">Backend offline — retrying</Badge>;
  }
  if (!health) return null;

  const loaded = health.engines.filter((engine) => engine.loaded);
  const missing = health.engines.filter((engine) => !engine.available);
  // Installed but with no weights on disk: the first generation would stall on
  // a multi-gigabyte download. Say so here rather than letting it surprise them.
  const unfetched = health.engines.filter(
    (engine) => engine.available && !engine.model_downloaded,
  );

  return (
    <div className="flex items-center gap-2">
      {!health.ffmpeg && <Badge tone="bad">ffmpeg not found</Badge>}
      {missing.map((engine) => (
        <Badge key={engine.name} tone="warn">
          {engine.name} not installed
        </Badge>
      ))}
      {unfetched.map((engine) => (
        <Badge key={engine.name} tone="warn">
          {engine.name} model not downloaded
        </Badge>
      ))}
      {loaded.map((engine) => (
        <Badge key={engine.name} tone="good">
          {engine.name} loaded{engine.device ? ` · ${engine.device}` : ""}
        </Badge>
      ))}
      {health.ffmpeg &&
        missing.length === 0 &&
        unfetched.length === 0 &&
        loaded.length === 0 && <Badge tone="good">Ready</Badge>}
    </div>
  );
}
