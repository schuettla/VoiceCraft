import { useCallback, useEffect, useState } from "react";
import { api } from "./lib/api";
import type { Health } from "./lib/types";
import { isTauri, setupApi } from "./lib/tauri";
import { cn } from "@/lib/utils";
import { ToastProvider } from "./components/Toaster";
import { EngineStatus } from "./components/EngineStatus";
import { UpdateNotifier } from "./components/UpdateNotifier";
import { ConfirmProvider } from "./components/Confirm";
import { AudioProvider, PlayerDock } from "./components/AudioPlayer";
import { AppSidebar, VIEW_LABEL, type View } from "./components/AppSidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfilesPage } from "./pages/Profiles";
import { GeneratePage, type GenerateHandoff } from "./pages/Generate";
import { LibraryPage } from "./pages/Library";
import { EditPage } from "./pages/Edit";
import { ModelsPage } from "./pages/Models";
import { SettingsPage } from "./pages/Settings";
import { SetupPage } from "./pages/Setup";

type Phase = "booting" | "setup" | "ready";

export default function App() {
  const [phase, setPhase] = useState<Phase>("booting");
  const [view, setView] = useState<View>("generate");
  const [health, setHealth] = useState<Health | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  // Set by the Library ("edit this clip", "use this script"); Generate takes it.
  const [handoff, setHandoff] = useState<GenerateHandoff | null>(null);
  const clearHandoff = useCallback(() => setHandoff(null), []);
  const openInGenerate = useCallback((next: GenerateHandoff) => {
    setHandoff(next);
    setView("generate");
  }, []);

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
        <span className="text-lg font-semibold tracking-tight text-white">
          Voice<span className="text-primary">Craft</span>
        </span>
        <span className="text-sm text-muted-foreground">Starting the speech engine…</span>
      </div>
    );
  }

  if (phase === "setup") {
    return (
      <TooltipProvider>
        <ToastProvider>
          <main className="h-full overflow-y-auto px-6">
            <SetupPage
              onReady={() => {
                setPhase("ready");
                void poll();
              }}
            />
          </main>
        </ToastProvider>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <ToastProvider>
        <ConfirmProvider>
        <UpdateNotifier />
        <AudioProvider>
          <SidebarProvider
            className="h-full min-h-0"
            style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
          >
            <AppSidebar
              view={view}
              onNavigate={setView}
              onRunSetup={() => setPhase("setup")}
            />
            <SidebarInset className="min-h-0 overflow-hidden">
              <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
                <SidebarTrigger className="-ml-1 text-muted-foreground" />
                <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
                <span className="text-sm text-muted-foreground">{VIEW_LABEL[view]}</span>
                <EngineStatus health={health} reachable={reachable} />
              </header>

              {/* The editor manages its own scrolling and fixed layout; every
                  other page scrolls inside a centred, readable column. */}
              <main
                className={cn(
                  "min-h-0 flex-1",
                  view === "edit" ? "overflow-hidden" : "overflow-y-auto",
                )}
              >
                {view === "edit" ? (
                  <EditPage />
                ) : (
                  <div className="mx-auto w-full max-w-4xl px-8 py-8">
                    {view === "profiles" && <ProfilesPage health={health} />}
                    {view === "generate" && (
                      <GeneratePage
                        health={health}
                        onOpenModels={() => setView("models")}
                        handoff={handoff}
                        onHandoffUsed={clearHandoff}
                      />
                    )}
                    {view === "library" && <LibraryPage onOpenInGenerate={openInGenerate} />}
                    {view === "models" && <ModelsPage />}
                    {view === "settings" && (
                      <SettingsPage onRunSetup={() => setPhase("setup")} />
                    )}
                  </div>
                )}
              </main>

              <PlayerDock />
            </SidebarInset>
          </SidebarProvider>
        </AudioProvider>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}
