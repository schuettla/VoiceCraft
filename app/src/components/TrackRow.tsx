import type { ReactNode } from "react";
import { useAudio, type Track } from "./AudioPlayer";
import { PlayIcon, PauseIcon, SpinnerIcon, WaveIcon } from "./icons";
import { cx } from "./ui";

/* One dense, scannable line: play toggle · title + meta · trailing actions,
 * with an optional detail block underneath. Used by the Generate session list,
 * the Library, the Edit clip tray, and the Profiles list so every row of audio
 * in the app looks and behaves the same. */

export function TrackRow({
  track,
  title,
  meta,
  badge,
  actions,
  detail,
  busy,
  selected,
  onSelectedChange,
  onClick,
}: {
  /** Omit for a row with no playable audio (a processing job, a preset voice). */
  track?: Track;
  /** Title to show when there is no playable track. */
  title?: string;
  meta?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  /** Rendered below the row, aligned past the play button. */
  detail?: ReactNode;
  busy?: boolean;
  selected?: boolean;
  onSelectedChange?: (next: boolean) => void;
  onClick?: () => void;
}) {
  const audio = useAudio();
  const isCurrent = !!track && audio.track?.id === track.id;
  const isPlaying = isCurrent && audio.playing;
  const playable = !!track && !busy;

  return (
    <div
      className={cx(
        "group rounded-md px-2 py-2 transition",
        selected ? "bg-accent-soft" : "hover:bg-white/[0.03]",
      )}
    >
      <div className="flex items-center gap-3">
        {onSelectedChange && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={(e) => onSelectedChange(e.target.checked)}
            className="size-3.5 shrink-0 accent-accent"
            aria-label="Select row"
          />
        )}

        <button
          type="button"
          disabled={!playable}
          onClick={() => track && audio.play(track)}
          className={cx(
            "grid size-8 shrink-0 place-items-center rounded-md border transition",
            isCurrent
              ? "border-transparent bg-accent text-ink-950"
              : "border-ink-700 text-ink-300 hover:border-ink-600 hover:text-ink-100",
            !playable && "opacity-40",
          )}
          aria-label={isPlaying ? "Pause" : busy ? "Working" : "Play"}
        >
          {busy ? (
            <SpinnerIcon />
          ) : !track ? (
            <WaveIcon />
          ) : isPlaying ? (
            <PauseIcon />
          ) : (
            <PlayIcon />
          )}
        </button>

        <button
          type="button"
          onClick={onClick ?? (track ? () => audio.play(track) : undefined)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <span
              className={cx(
                "truncate text-[13px]",
                isCurrent ? "text-accent" : "text-ink-200",
              )}
            >
              {track?.title ?? title ?? "Untitled"}
            </span>
            {badge}
          </div>
          {meta && (
            <div className="mt-0.5 truncate text-[11px] text-ink-400">{meta}</div>
          )}
        </button>

        {actions && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition group-hover:opacity-100">
            {actions}
          </div>
        )}
      </div>

      {detail && <div className="mt-2 pl-11">{detail}</div>}
    </div>
  );
}
