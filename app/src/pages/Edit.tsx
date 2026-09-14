import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Project, ProjectSummary } from "../lib/types";
import { useToast } from "../components/Toaster";
import { SpinnerIcon } from "../components/icons";
import { MediaProvider } from "../editor/MediaContext";
import { EditorProvider } from "../editor/store";
import { EngineProvider } from "../editor/EngineContext";
import { useLayout } from "../editor/useLayout";
import { emptyProject } from "../editor/ops";
import { Toolbar } from "../editor/components/Toolbar";
import { MediaBin } from "../editor/components/MediaBin";
import { Timeline } from "../editor/components/Timeline";
import { Inspector } from "../editor/components/Inspector";
import { Transport } from "../editor/components/Transport";
import { KeyboardShortcuts } from "../editor/components/KeyboardShortcuts";
import { ProjectDialog } from "../editor/components/ProjectDialog";

/* A full local multitrack audio editor: load generated clips and imported
 * audio onto a waveform timeline, arrange/trim/fade them, keep a pinned
 * intro/outro, mix multiple tracks with ducking, run ffmpeg effects, and
 * export — all backed by a saved, autosaving project (see backend's
 * EditProject + utils/timeline.py). This page just bootstraps the most
 * recent project and lays out the editor's panels; the real state lives in
 * editor/store.tsx. */

export function EditPage() {
  const toast = useToast();
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [showProjects, setShowProjects] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(true);

  const refreshList = useCallback(async () => {
    try {
      setSummaries(await api.listProjects());
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }, [toast]);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listProjects();
      setSummaries(list);
      if (list.length > 0) {
        setProject(await api.getProject(list[0].id));
      } else {
        setProject(await api.createProject("Untitled project", emptyProject()));
      }
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openProject(id: string) {
    setLoading(true);
    try {
      // Refresh the list too: names and timestamps change while editing.
      const [opened] = await Promise.all([api.getProject(id), refreshList()]);
      setProject(opened);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function newProject() {
    setLoading(true);
    try {
      const created = await api.createProject("Untitled project", emptyProject());
      setProject(created);
      await refreshList();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function deleteProjectById(id: string) {
    const target = summaries.find((s) => s.id === id);
    if (!window.confirm(`Delete project "${target?.name ?? "this project"}"? Its rendered exports are kept.`)) return;
    try {
      await api.deleteProject(id);
      if (id === project?.id) await bootstrap();
      else await refreshList();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  if (loading || !project) {
    return (
      <div className="flex h-[70vh] items-center justify-center gap-2 text-ink-400">
        <SpinnerIcon /> Loading editor…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <MediaProvider>
        <EditorProvider
          key={project.id}
          projectId={project.id}
          projectName={project.name}
          initialData={project.data}
        >
          <EngineProvider>
            <KeyboardShortcuts />
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-ink-700">
              <Toolbar
                onOpenProjects={() => setShowProjects(true)}
                mediaOpen={mediaOpen}
                onToggleMedia={() => setMediaOpen((v) => !v)}
              />
              <div className="flex min-h-0 flex-1">
                {mediaOpen && (
                  <div className="w-64 shrink-0">
                    <MediaBin />
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-2 p-2">
                  <Timeline />
                  <TransportBar />
                </div>
                <div className="w-80 shrink-0">
                  <Inspector />
                </div>
              </div>
            </div>
          </EngineProvider>
        </EditorProvider>
      </MediaProvider>

      {showProjects && (
        <ProjectDialog
          summaries={summaries}
          currentId={project.id}
          onSelect={(id) => void openProject(id)}
          onCreate={() => void newProject()}
          onDelete={(id) => void deleteProjectById(id)}
          onClose={() => setShowProjects(false)}
        />
      )}
    </div>
  );
}

/** Reads the same layout the timeline uses, so the transport's total-duration
 * readout always matches what's on screen. */
function TransportBar() {
  return <Transport totalDuration={useLayout().layout.totalDuration} />;
}
