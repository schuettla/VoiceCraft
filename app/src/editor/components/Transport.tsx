import { useEffect, useRef } from "react";
import { formatDuration } from "../../lib/format";
import { PauseIcon, PlayIcon, XIcon } from "../../components/icons";
import { IconButton } from "../../components/common";
import { Button } from "@/components/ui/button";
import { useEditor } from "../store";
import { useEngine } from "../EngineContext";

export function Transport({ totalDuration }: { totalDuration: number }) {
  const editor = useEditor();
  const engine = useEngine();
  const meterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf: number;
    const data = new Uint8Array(engine.analyser.fftSize);
    const loop = () => {
      engine.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) {
        const centered = (v - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / data.length);
      if (meterRef.current) meterRef.current.style.width = `${Math.min(100, rms * 220)}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine.analyser]);

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <Button
        size="icon-sm"
        className="rounded-full"
        onClick={() => void engine.toggle()}
        aria-label={engine.playing ? "Pause" : "Play"}
      >
        {engine.playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <IconButton label="Stop" onClick={engine.stop}>
        <XIcon />
      </IconButton>
      <span className="font-mono text-[12px] tabular-nums text-foreground">
        {formatDuration(editor.state.playhead)}{" "}
        <span className="text-muted-foreground">/ {formatDuration(totalDuration)}</span>
      </span>
      <div className="ml-auto flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Level</span>
        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-ink-800">
          <div ref={meterRef} className="h-full w-0 bg-pulse-green transition-[width] duration-75" />
        </div>
      </div>
    </div>
  );
}
