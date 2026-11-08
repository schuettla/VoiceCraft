import { useState } from "react";
import type { ProjectSummary } from "../../lib/types";
import { formatWhen } from "../../lib/format";
import { IconButton, cx } from "../../components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
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
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="pl-9"
          />
        </div>
        <div className="max-h-80 space-y-0.5 overflow-y-auto">
          {visible.length === 0 && <p className="py-6 text-center text-[13px] text-muted-foreground">No projects match.</p>}
          {visible.map((s) => (
            <div
              key={s.id}
              className={cx(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[13px]",
                s.id === currentId
                  ? "border-primary/50 bg-primary/10 text-white"
                  : "border-transparent text-foreground hover:bg-accent/50",
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
                <span className="block text-[11px] text-muted-foreground">{formatWhen(s.updated_at)}</span>
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
