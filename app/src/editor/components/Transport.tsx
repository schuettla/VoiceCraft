import { useEffect, useRef } from "react";
import { formatDuration } from "../../lib/format";
import { PauseIcon, PlayIcon, XIcon } from "../../components/icons";
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
    <div className="flex items-center gap-3 border-t border-ink-700 bg-ink-900 px-3 py-2">
      <button
        onClick={() => void engine.toggle()}
        className="grid size-8 place-items-center rounded-md bg-accent text-ink-950 transition hover:bg-accent-strong"
        aria-label={engine.playing ? "Pause" : "Play"}
      >
        {engine.playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        onClick={engine.stop}
        className="grid size-7 place-items-center rounded-md text-ink-400 transition hover:bg-white/5 hover:text-ink-100"
        aria-label="Stop"
      >
        <XIcon />
      </button>
      <span className="font-mono text-[12px] tabular-nums text-ink-300">
        {formatDuration(editor.state.playhead)} / {formatDuration(totalDuration)}
      </span>
      <div className="ml-4 h-1.5 w-32 overflow-hidden rounded-full bg-ink-800">
        <div ref={meterRef} className="h-full w-0 bg-pulse-green transition-[width] duration-75" />
      </div>
      <span className="ml-2 text-[11px] text-ink-500">level</span>
    </div>
  );
}
