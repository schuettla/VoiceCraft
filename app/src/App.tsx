import { useCallback, useEffect, useState } from "react";
import { api } from "./lib/api";
import type { Health } from "./lib/types";
import { isTauri, setupApi } from "./lib/tauri";
import { cn } from "@/lib/utils";
import { ToastProvider } from "./components/Toaster";
import { StatusBar } from "./components/StatusBar";
import { BareTitleBar, WindowControls } from "./components/WindowControls";
import { PageBarSlot, TOOLBAR_H } from "./components/common";
import { UpdateNotifier } from "./components/UpdateNotifier";
import { ConfirmProvider } from "./components/Confirm";
import { AudioProvider, PlayerDock } from "./components/AudioPlayer";
import { AppSidebar, NAV_GROUPS, type View } from "./components/AppSidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useDesktopBehavior } from "@/hooks/use-desktop-behavior";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfilesPage } from "./pages/Profiles";
import { GeneratePage, type GenerateHandoff } from "./pages/Generate";
import { LibraryPage } from "./pages/Library";
import { EditPage } from "./pages/Edit";
import { ModelsPage } from "./pages/Models";
import { SettingsPage } from "./pages/Settings";
import { SetupPage } from "./pages/Setup";

/** Views that lay out their own panes and scrolling instead of one scrolling page. */
const FULL_BLEED: View[] = ["edit", "generate", "settings"];

/** Nav order, so Ctrl+1…6 matches what the sidebar shows top to bottom. */
const VIEW_ORDER = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));

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

  useDesktopBehavior(VIEW_ORDER, setView);
  // The top-row element pages portal their header into (see PageHeader).
  const [pageBar, setPageBar] = useState<HTMLElement | null>(null);

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
      <div className="flex h-full flex-col">
        <BareTitleBar />
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <span className="text-lg font-semibold tracking-tight text-white">
            Voice<span className="text-primary">Craft</span>
          </span>
          <span className="text-sm text-muted-foreground">Starting the speech engine…</span>
        </div>
      </div>
    );
  }

  if (phase === "setup") {
    return (
      <TooltipProvider>
        <ToastProvider>
          <div className="flex h-full flex-col">
            <BareTitleBar />
            <main className="min-h-0 flex-1 overflow-y-auto px-6">
              <SetupPage
                onReady={() => {
                  setPhase("ready");
                  void poll();
                }}
              />
            </main>
          </div>
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
              {/* The window's top row: the current page's bar (portalled in by
                  PageHeader) and, on Windows, the caption buttons. */}
              <header
                data-tauri-drag-region
                className={cn("flex shrink-0 items-stretch border-b bg-background", TOOLBAR_H)}
              >
                <div ref={setPageBar} data-tauri-drag-region className="flex min-w-0 flex-1" />
                <WindowControls />
              </header>
              <PageBarSlot.Provider value={pageBar}>
              {/* The editor and Generate manage their own panes and scrolling;
                  every other page scrolls as one column. */}
              <main
                className={cn(
                  "min-h-0 flex-1",
                  FULL_BLEED.includes(view) ? "overflow-hidden" : "overflow-y-auto",
                )}
              >
                {view === "edit" && <EditPage />}
                {view === "generate" && (
                  <GeneratePage
                    health={health}
                    onOpenModels={() => setView("models")}
                    handoff={handoff}
                    onHandoffUsed={clearHandoff}
                  />
                )}
                {view === "settings" && <SettingsPage onRunSetup={() => setPhase("setup")} />}
                {!FULL_BLEED.includes(view) && (
                  <div className="px-6 py-5">
                    {view === "profiles" && <ProfilesPage health={health} />}
                    {view === "library" && <LibraryPage onOpenInGenerate={openInGenerate} />}
                    {view === "models" && <ModelsPage />}
                  </div>
                )}
              </main>
              </PageBarSlot.Provider>

              <PlayerDock />
              <StatusBar
                health={health}
                reachable={reachable}
                onOpenModels={() => setView("models")}
                onRunSetup={() => setPhase("setup")}
              />
            </SidebarInset>
          </SidebarProvider>
        </AudioProvider>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}
