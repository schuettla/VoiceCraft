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
import { cx } from "./ui";

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
    <AudioCtx.Provider value={value}>
      {children}
      <PlayerBar />
    </AudioCtx.Provider>
  );
}

function PlayerBar() {
  const { track, playing, time, duration, toggle, seek, stop } = useAudio();
  if (!track) return null;

  const pct = duration > 0 ? (time / duration) * 100 : 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-900/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-2.5">
        <button
          onClick={toggle}
          className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-ink-950 transition hover:bg-accent-strong"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-[13px] text-ink-200">{track.title}</p>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-400">
              {formatDuration(time)} / {formatDuration(duration)}
            </span>
          </div>
          <Scrubber pct={pct} duration={duration} onSeek={seek} />
          {track.subtitle && (
            <p className="mt-0.5 truncate text-[11px] text-ink-400">
              {track.subtitle}
            </p>
          )}
        </div>

        <button
          onClick={stop}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-400 transition hover:bg-white/5 hover:text-ink-100"
          aria-label="Close player"
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}

function Scrubber({
  pct,
  duration,
  onSeek,
}: {
  pct: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  function handle(event: React.MouseEvent<HTMLDivElement>) {
    if (duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  }
  return (
    <div
      onClick={handle}
      className="group mt-1 h-2.5 cursor-pointer"
      role="slider"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
    >
      <div className="relative top-1 h-1 rounded-full bg-ink-700">
        <div
          className={cx(
            "absolute inset-y-0 left-0 rounded-full bg-ink-300 transition-[width] duration-150",
            "group-hover:bg-accent",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
