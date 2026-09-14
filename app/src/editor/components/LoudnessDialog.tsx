import { useState } from "react";
import type { LoudnessReport } from "../../lib/types";
import { Button, Field, Select } from "../../components/ui";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toaster";
import { useMedia } from "../MediaContext";
import { useEditor } from "../store";

/** Measures any source in the media bin against the project's master loudness
 * target — the analyze/loudness endpoint already existed but had no UI. */
export function LoudnessDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditor();
  const media = useMedia();
  const toast = useToast();
  const target = editor.state.data.master.loudness.target_lufs;
  const [key, setKey] = useState(media.clips[0]?.key ?? "");
  const [report, setReport] = useState<LoudnessReport | null>(null);
  const [busy, setBusy] = useState(false);

  async function measure() {
    const clip = media.byKey.get(key);
    if (!clip) return;
    setBusy(true);
    setReport(null);
    try {
      setReport(await api.analyzeLoudness(clip.ref));
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const withinTarget = report?.integrated_lufs != null && Math.abs(report.integrated_lufs - target) <= 1;

  return (
    <Dialog onClose={onClose} title="Loudness report" footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <Field label="Source">
          <Select
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setReport(null);
            }}
          >
            {media.clips.length === 0 && <option value="">Nothing to measure yet</option>}
            {media.clips.map((c) => (
              <option key={c.key} value={c.key}>
                {c.title}
              </option>
            ))}
          </Select>
        </Field>
        <Button size="sm" onClick={measure} disabled={!key || busy}>
          {busy ? "Measuring…" : "Measure"}
        </Button>
        {report && (
          <div className="space-y-1 border border-ink-700 bg-white/[0.02] p-3 text-[12px]">
            <Row label="Integrated loudness" value={report.integrated_lufs} unit=" LUFS" />
            <Row label="True peak" value={report.true_peak_db} unit=" dBTP" />
            <Row label="Loudness range" value={report.loudness_range} unit=" LU" />
            <p className={withinTarget ? "mt-1 text-pulse-green" : "mt-1 text-[#e2b93b]"}>
              {withinTarget
                ? `Within 1 LU of the ${target} LUFS master target.`
                : `Master target is ${target} LUFS — normalize on export to match it.`}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Row({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <div className="flex justify-between text-ink-300">
      <span className="text-ink-400">{label}</span>
      <span className="font-mono">{value != null ? `${value.toFixed(1)}${unit}` : "—"}</span>
    </div>
  );
}
