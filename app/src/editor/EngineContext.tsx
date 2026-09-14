import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SourceRef } from "../lib/types";
import { fileUrl } from "../lib/api";
import { useAudio } from "../components/AudioPlayer";
import { PlaybackEngine } from "./engine";
import { useMedia } from "./MediaContext";
import { useEditor } from "./store";
import { useLayout } from "./useLayout";
import * as ops from "./ops";

type EngineContextValue = {
  playing: boolean;
  toggle: () => Promise<void>;
  stop: () => void;
  analyser: AnalyserNode;
};

const EngineCtx = createContext<EngineContextValue | null>(null);

export function useEngine(): EngineContextValue {
  const value = useContext(EngineCtx);
  if (!value) throw new Error("useEngine must be used inside <EngineProvider>");
  return value;
}

export function EngineProvider({ children }: { children: ReactNode }) {
  const editor = useEditor();
  const media = useMedia();
  const { layout } = useLayout();
  const globalAudio = useAudio();
  const [engine, setEngine] = useState<PlaybackEngine | null>(null);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | undefined>(undefined);

  // The transport callbacks are memoized on `playing` only, so they read the
  // document, media catalog, and layout through this ref — never a stale
  // render's closure.
  const latest = useRef({ editor, media, layout, globalAudio });
  latest.current = { editor, media, layout, globalAudio };

  // Created in an effect (not during render) so StrictMode's mount/unmount/
  // remount cycle closes the first AudioContext and keeps a live second one.
  useEffect(() => {
    const created = new PlaybackEngine();
    setEngine(created);
    return () => {
      window.cancelAnimationFrame(rafRef.current ?? 0);
      created.dispose();
    };
  }, []);

  // Only one transport should be audible at a time.
  useEffect(() => {
    if (engine && globalAudio.playing && engine.isPlaying) {
      engine.pauseAt(engine.currentTime);
      setPlaying(false);
    }
  }, [globalAudio.playing, engine]);

  const value = useMemo<EngineContextValue | null>(() => {
    if (!engine) return null;
    const live: PlaybackEngine = engine; // narrowed for the closures below
    function urlFor(source: SourceRef): string | null {
      const clip = latest.current.media.byKey.get(ops.sourceKey(source));
      return clip ? fileUrl(clip.path) : null;
    }

    function tick() {
      if (!live.isPlaying) {
        latest.current.editor.setPlayhead(live.currentTime);
        setPlaying(false);
        return;
      }
      const loop = latest.current.editor.state.loop;
      if (loop && live.currentTime >= loop.end) {
        const { editor: ed, layout: lay } = latest.current;
        ed.setPlayhead(loop.start);
        void live.play(ed.state.data, lay, urlFor, loop.start, () => setPlaying(false));
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      latest.current.editor.setPlayhead(live.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    }

    async function toggle() {
      window.cancelAnimationFrame(rafRef.current ?? 0);
      if (live.isPlaying) {
        live.pauseAt(live.currentTime);
        latest.current.editor.setPlayhead(live.currentTime);
        setPlaying(false);
        return;
      }
      const { editor: ed, layout: lay, globalAudio: audio } = latest.current;
      if (audio.playing) audio.stop();
      const loop = ed.state.loop;
      const startAt = loop && (ed.state.playhead < loop.start || ed.state.playhead >= loop.end) ? loop.start : ed.state.playhead;
      const started = await live.play(ed.state.data, lay, urlFor, startAt, () => setPlaying(false));
      if (!started) return;
      setPlaying(true);
      rafRef.current = requestAnimationFrame(tick);
    }

    function stop() {
      window.cancelAnimationFrame(rafRef.current ?? 0);
      live.pauseAt(0);
      setPlaying(false);
      latest.current.editor.setPlayhead(0);
    }

    return { playing, toggle, stop, analyser: live.analyser };
  }, [playing, engine]);

  // Consumers (transport, shortcuts) need a live engine; the gap is one frame.
  if (!value) return null;
  return <EngineCtx.Provider value={value}>{children}</EngineCtx.Provider>;
}
