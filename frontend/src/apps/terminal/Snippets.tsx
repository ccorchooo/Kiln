import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerDownLeft, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { toastError } from "../../lib/toasts";

export interface Snippet {
  id: string;
  name: string;
  command: string;
  description: string;
}

interface Props {
  onRun: (command: string) => void;
  onInsert: (command: string) => void;
  onClose: () => void;
}

const field =
  "w-full rounded-[10px] border border-[var(--hairline-strong)] bg-transparent px-3 py-2 text-sm text-ink outline-none focus:border-accent";

export function Snippets({ onRun, onInsert, onClose }: Props) {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({
    queryKey: ["snippets"],
    queryFn: () => api<Snippet[]>("/api/snippets"),
  });
  const [editing, setEditing] = useState<Partial<Snippet> | null>(null);
  const [filter, setFilter] = useState("");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing?.name?.trim() || !editing.command?.trim()) return;
    const body = {
      name: editing.name.trim(),
      command: editing.command,
      description: editing.description ?? "",
    };
    try {
      if (editing.id) await api(`/api/snippets/${editing.id}`, { method: "PUT", body });
      else await api("/api/snippets", { method: "POST", body });
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["snippets"] });
    } catch (err) {
      toastError("Couldn't save the snippet", err);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/snippets/${id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["snippets"] });
    } catch (err) {
      toastError("Couldn't delete the snippet", err);
    }
  };

  const shown = data.filter((s) =>
    `${s.name} ${s.command} ${s.description}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h3 className="heading-display flex-1 text-xl text-ink">Snippets</h3>
        <button
          type="button"
          onClick={() => setEditing({ name: "", command: "", description: "" })}
          className="grid size-8 place-items-center rounded-full text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"
          aria-label="New snippet"
        >
          <Plus className="size-4" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="grid size-8 place-items-center rounded-full text-ink-2 hover:bg-[var(--hairline)] hover:text-ink"
          aria-label="Close snippets"
        >
          <X className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-2 px-4 pb-4">
          <input
            autoFocus
            className={field}
            placeholder="Name"
            maxLength={80}
            value={editing.name ?? ""}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            aria-label="Snippet name"
          />
          <textarea
            className={`${field} num min-h-24 resize-y`}
            placeholder="Command"
            maxLength={4096}
            value={editing.command ?? ""}
            onChange={(e) => setEditing({ ...editing, command: e.target.value })}
            aria-label="Command"
          />
          <input
            className={field}
            placeholder="Description (optional)"
            maxLength={300}
            value={editing.description ?? ""}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            aria-label="Description"
          />
          <div className="flex gap-2">
            <button type="submit" className="rounded-full bg-accent-fill px-4 py-1.5 text-sm text-on-accent">
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-full px-4 py-1.5 text-sm text-ink-2 hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="px-4 pb-2">
            <input
              className={field}
              placeholder="Filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter snippets"
            />
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {isLoading && <li className="px-2 py-3 text-sm text-ink-2">Loading…</li>}
            {!isLoading && shown.length === 0 && (
              <li className="px-2 py-3 text-sm text-ink-2">
                {data.length
                  ? "No matches."
                  : "Save commands you run often. They run in the focused pane with one click."}
              </li>
            )}
            {shown.map((s) => (
              <li key={s.id} className="group rounded-[12px] px-2 py-2 hover:bg-[var(--hairline)]">
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{s.name}</span>
                  <button
                    type="button"
                    onClick={() => onRun(s.command)}
                    className="grid size-7 place-items-center rounded-full text-accent-ink hover:bg-accent-soft"
                    aria-label={`Run ${s.name}`}
                    title="Run"
                  >
                    <Play className="size-3.5" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onInsert(s.command)}
                    className="grid size-7 place-items-center rounded-full text-ink-2 hover:text-ink"
                    aria-label={`Insert ${s.name} without running`}
                    title="Insert without running"
                  >
                    <CornerDownLeft className="size-3.5" strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(s)}
                    className="grid size-7 place-items-center rounded-full text-ink-2 hover:text-ink"
                    aria-label={`Edit ${s.name}`}
                  >
                    <Pencil className="size-3.5" strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(s.id)}
                    className="grid size-7 place-items-center rounded-full text-ink-2 hover:text-danger-ink"
                    aria-label={`Delete ${s.name}`}
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                  </button>
                </div>
                <code className="num mt-1 block truncate text-xs text-ink-2">{s.command}</code>
                {s.description && <p className="text-xs text-ink-2">{s.description}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
