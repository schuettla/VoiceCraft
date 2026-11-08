import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fileUrl } from "../lib/api";
import { formatDuration } from "../lib/format";
import { PlayIcon, PauseIcon, XIcon } from "./icons";
import { IconButton } from "./common";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

/* One <audio> element for the whole app.
 *
 * Every list row plays through this shared transport instead of embedding its
 * own <audio controls>. That keeps rows dense and scannable, gives one
 * consistent set of controls, and means starting a new clip stops the last one.
 */

export type Track = {
  /** Stable id — a generation id, asset id, or any unique string. */
  id: string;
  /** Managed file path (not a URL); the bar resolves it through the backend. */
  path: string;
  title: string;
  subtitle?: string;
};

type AudioContextValue = {
  track: Track | null;
  playing: boolean;
  /** Current position and length in seconds (0 until metadata loads). */
  time: number;
  duration: number;
  /** Load a track and start it. Same id again just toggles play/pause. */
  play: (track: Track) => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  stop: () => void;
};

const AudioCtx = createContext<AudioContextValue | null>(null);

export function useAudio(): AudioContextValue {
  const value = useContext(AudioCtx);
  if (!value) throw new Error("useAudio must be used inside <AudioProvider>");
  return value;
}

export function AudioProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  if (ref.current === null && typeof Audio !== "undefined") {
    ref.current = new Audio();
    ref.current.preload = "metadata";
  }

  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () => setTime(el.currentTime);
    const onMeta = () =>
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnd = () => {
      setPlaying(false);
      setTime(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnd);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnd);
    };
  }, []);

  const play = useCallback(
    (next: Track) => {
      const el = ref.current;
      if (!el) return;
      if (track?.id === next.id) {
        if (el.paused) void el.play().catch(() => undefined);
        else el.pause();
        return;
      }
      setTrack(next);
      setTime(0);
      setDuration(0);
      el.src = fileUrl(next.path);
      el.currentTime = 0;
      void el.play().catch(() => undefined);
    },
    [track],
  );

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el || !track) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, [track]);

  const seek = useCallback((seconds: number) => {
    const el = ref.current;
    if (!el) return;
    el.currentTime = seconds;
    setTime(seconds);
  }, []);

  const stop = useCallback(() => {
    const el = ref.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    setTrack(null);
    setPlaying(false);
    setTime(0);
    setDuration(0);
  }, []);

  const value = useMemo(
    () => ({ track, playing, time, duration, play, toggle, seek, stop }),
    [track, playing, time, duration, play, toggle, seek, stop],
  );

  return (
    <AudioCtx.Provider value={value}>{children}</AudioCtx.Provider>
  );
}


/** The persistent player. Lives in the shell's layout flow (not fixed over the
 * content), so pages never need bottom padding to clear it. */
export function PlayerDock() {
  const { track, playing, time, duration, toggle, seek, stop } = useAudio();
  if (!track) return null;

  return (
    <div className="flex shrink-0 items-center gap-4 border-t bg-card px-5 py-2.5">
      <Button
        size="icon"
        className="size-8 shrink-0 rounded-full"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>

      <div className="min-w-0 basis-56">
        <p className="truncate text-[13px] font-medium text-foreground">{track.title}</p>
        {track.subtitle && (
          <p className="truncate text-xs text-muted-foreground">{track.subtitle}</p>
        )}
      </div>

      <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatDuration(time)}
      </span>
      <Slider
        className="min-w-0 flex-1"
        value={[Math.min(time, duration || 0)]}
        max={duration > 0 ? duration : 1}
        step={0.05}
        disabled={duration <= 0}
        onValueChange={([next]) => seek(next)}
        aria-label="Seek"
      />
      <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatDuration(duration)}
      </span>

      <IconButton label="Close player" onClick={stop}>
        <XIcon />
      </IconButton>
    </div>
  );
}
