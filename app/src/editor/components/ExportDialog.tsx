import { useEffect, useRef, useState } from "react";
import { AUDIO_FORMATS, formatDuration } from "../../lib/format";
import type { AudioFormat, RenderJob } from "../../lib/types";
import { api } from "../../lib/api";
import { Button, Field, Select } from "../../components/ui";
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
          <Button onClick={cancel}>{job?.state === "rendering" || job?.state === "measuring" ? "Cancel" : "Close"}</Button>
          {!job && (
            <Button variant="primary" onClick={startRender}>
              Render
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Format">
          <Select value={format} onChange={(e) => setFormat(e.target.value as AudioFormat)}>
            {AUDIO_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </Select>
        </Field>

        {job && (
          <div className="border border-ink-700 bg-white/[0.02] p-3">
            <div className="flex items-center justify-between text-[12px] text-ink-300">
              <span className="capitalize">{job.state}</span>
              <span className="font-mono">{Math.round(job.progress * 100)}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${Math.round(job.progress * 100)}%` }}
              />
            </div>
            {job.state === "completed" && job.asset && (
              <div className="mt-3 space-y-2">
                <p className="text-[12px] text-ink-300">
                  {job.asset.name} · {formatDuration(job.asset.duration_seconds)}
                </p>
                <Button size="sm" onClick={() => api.reveal(job.asset!.path)}>
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
