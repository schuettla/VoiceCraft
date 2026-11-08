import type { ReactNode } from "react";
import { useAudio, type Track } from "./AudioPlayer";
import { PlayIcon, PauseIcon, SpinnerIcon, WaveIcon } from "./icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/* One dense, scannable line: play toggle · title + meta · trailing actions,
 * with an optional detail block underneath. Rows sit directly on the page and
 * are separated by hairlines (wrap a list in `divide-y`) — no per-row boxes.
 * Used by the Generate results, the Library, the Edit clip tray and the
 * Profiles list so every row of audio in the app behaves the same. */

export function TrackRow({
  track,
  title,
  meta,
  leading,
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
  /** Small marker before the title (the kind of audio: voice, music, effect). */
  leading?: ReactNode;
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
      className={cn(
        "group px-2 py-3 transition-colors",
        selected ? "bg-primary/10" : "hover:bg-accent/40",
      )}
    >
      <div className="flex items-center gap-3">
        {onSelectedChange && (
          <Checkbox
            checked={!!selected}
            onCheckedChange={(next) => onSelectedChange(next === true)}
            aria-label="Select row"
          />
        )}

        <Button
          type="button"
          size="icon-sm"
          variant={isCurrent ? "default" : "outline"}
          disabled={!playable}
          onClick={() => track && audio.play(track)}
          className={cn("shrink-0 rounded-full", !isCurrent && "text-muted-foreground")}
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
        </Button>

        <button
          type="button"
          onClick={onClick ?? (track ? () => audio.play(track) : undefined)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            {leading}
            <span
              className={cn(
                "truncate text-sm",
                isCurrent ? "font-medium text-primary" : "text-foreground",
              )}
            >
              {track?.title ?? title ?? "Untitled"}
            </span>
            {badge}
          </div>
          {meta && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</div>
          )}
        </button>

        {actions && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
            {actions}
          </div>
        )}
      </div>

      {detail && <div className="mt-2 pl-11">{detail}</div>}
    </div>
  );
}
