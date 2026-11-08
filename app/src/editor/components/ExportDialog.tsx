import { useEffect, useRef, useState } from "react";
import { AUDIO_FORMATS, formatDuration } from "../../lib/format";
import type { AudioFormat, RenderJob } from "../../lib/types";
import { api } from "../../lib/api";
import { Field, OptionSelect } from "../../components/common";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toaster";
import { useMedia } from "../MediaContext";
import { useEditor } from "../store";

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditor();
  const media = useMedia();
  const toast = useToast();
  const data = editor.state.data;
  const [format, setFormat] = useState<AudioFormat>(data.export.output_format);
  const [job, setJob] = useState<RenderJob | null>(null);
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(pollRef.current), []);

  async function startRender() {
    const next = { ...data, export: { ...data.export, output_format: format } };
    editor.apply(next);
    try {
      // Send the live document: the saved copy may still be behind the autosave debounce.
      const started = await api.startRender(editor.state.projectId, editor.state.projectName, next);
      setJob(started);
      poll(started.id);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  function poll(jobId: string) {
    pollRef.current = window.setTimeout(async () => {
      try {
        const next = await api.getRenderJob(jobId);
        setJob(next);
        if (next.state === "queued" || next.state === "rendering") {
          poll(jobId);
        } else if (next.state === "completed") {
          toast(`Exported ${next.asset?.name ?? "episode"}`, "success");
          void media.refresh();
        } else if (next.state === "failed") {
          toast(next.error ?? "Render failed", "error");
        }
      } catch (error) {
        toast((error as Error).message, "error");
      }
    }, 400);
  }

  async function cancel() {
    if (job) await api.cancelRender(job.id).catch(() => undefined);
    onClose();
  }

  return (
    <Dialog
      onClose={onClose}
      title="Export"
      footer={
        <>
          <Button variant="outline" onClick={cancel}>{job?.state === "rendering" || job?.state === "measuring" ? "Cancel" : "Close"}</Button>
          {!job && (
            <Button onClick={startRender}>
              Render
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Format">
          <OptionSelect
            value={format}
            onChange={(value) => setFormat(value as AudioFormat)}
            options={AUDIO_FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }))}
          />
        </Field>

        {job && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[13px] text-muted-foreground">
              <span className="capitalize">{job.state}</span>
              <span className="font-mono">{Math.round(job.progress * 100)}%</span>
            </div>
            <Progress className="h-1.5" value={Math.round(job.progress * 100)} />
            {job.state === "completed" && job.asset && (
              <div className="mt-3 space-y-2">
                <p className="text-[13px] text-muted-foreground">
                  {job.asset.name} · {formatDuration(job.asset.duration_seconds)}
                </p>
                <Button size="sm" variant="outline" onClick={() => api.reveal(job.asset!.path)}>
                  Reveal in folder
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
