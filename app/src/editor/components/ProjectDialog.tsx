import { useState } from "react";
import type { ProjectSummary } from "../../lib/types";
import { formatWhen } from "../../lib/format";
import { Button, IconButton, cx } from "../../components/ui";
import { Dialog } from "../../components/Dialog";
import { PlusIcon, SearchIcon, TrashIcon } from "../../components/icons";

/** The project picker, as a searchable list in a dialog rather than an inline
 * dropdown — the editor's header stays a single compact control. */
export function ProjectDialog({
  summaries,
  currentId,
  onSelect,
  onCreate,
  onDelete,
  onClose,
}: {
  summaries: ProjectSummary[];
  currentId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = summaries.filter((s) => !needle || s.name.toLowerCase().includes(needle));

  return (
    <Dialog
      onClose={onClose}
      title="Projects"
      className="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onCreate();
              onClose();
            }}
          >
            <PlusIcon /> New project
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="w-full border border-white/10 bg-white/[0.02] py-1.5 pl-8 pr-2 text-[13px] text-ink-200 placeholder:text-ink-400 focus:border-ink-200 focus:outline-none"
          />
        </div>
        <div className="max-h-80 space-y-0.5 overflow-y-auto">
          {visible.length === 0 && <p className="py-6 text-center text-[12px] text-ink-400">No projects match.</p>}
          {visible.map((s) => (
            <div
              key={s.id}
              className={cx(
                "flex items-center gap-2 border px-2.5 py-1.5 text-[13px]",
                s.id === currentId
                  ? "border-accent/60 bg-accent/10 text-white"
                  : "border-transparent text-ink-200 hover:bg-white/5",
              )}
            >
              <button
                type="button"
                onClick={() => {
                  onSelect(s.id);
                  onClose();
                }}
                className="min-w-0 flex-1 truncate text-left"
              >
                <span className="block truncate">{s.name}</span>
                <span className="block text-[11px] text-ink-500">{formatWhen(s.updated_at)}</span>
              </button>
              <IconButton label="Delete project" className="hover:text-coral-red" onClick={() => onDelete(s.id)}>
                <TrashIcon />
              </IconButton>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
