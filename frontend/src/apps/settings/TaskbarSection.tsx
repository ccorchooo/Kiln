import { AnimatePresence, motion, Reorder } from "framer-motion";
import { ChevronDown, GripVertical, Lock, LockOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { spring } from "../../components/motion";
import { newWidget, useWidgets } from "../../widgets/store";
import {
  CATEGORY,
  CATEGORY_LABEL,
  MAX_WIDGETS,
  type WidgetConfig,
  type WidgetType,
} from "../../widgets/types";
import { WIDGETS } from "../../widgets/Widget";

const LOCK_NOTE: Partial<Record<WidgetType, string>> = {
  media: "Titles stay hidden on the lock screen unless you allow them below.",
  network: "The lock screen never shows your Tailscale IP or exit node.",
  notifications: "Notification contents never appear on the lock screen.",
};

function Options({ w, update }: { w: WidgetConfig; update: (w: WidgetConfig) => void }) {
  const set = (k: string, v: unknown) => update({ ...w, options: { ...w.options, [k]: v } });
  if (w.type === "clock")
    return (
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={w.options.seconds === true}
            onChange={(e) => set("seconds", e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Show seconds
        </label>
        <label className="flex flex-col gap-1 text-sm text-ink">
          Second time zone (shown when expanded)
          <input
            list="kiln-timezones"
            defaultValue={typeof w.options.timezone === "string" ? w.options.timezone : ""}
            onBlur={(e) => set("timezone", e.target.value.trim())}
            placeholder="e.g. Europe/Madrid"
            className="num rounded-[10px] border border-[var(--hairline-strong)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <datalist id="kiln-timezones">
            {(Intl.supportedValuesOf?.("timeZone") ?? []).map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </label>
      </div>
    );
  if (w.type === "media")
    return (
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={w.options.show_titles_on_lock === true}
          onChange={(e) => set("show_titles_on_lock", e.target.checked)}
          className="accent-[var(--accent)]"
        />
        Show track titles on the lock screen
      </label>
    );
  if (w.type === "weather")
    return (
      <p className="text-sm text-ink-2">
        Location comes from <code className="num">[location]</code> in config.toml.
      </p>
    );
  return <p className="text-sm text-ink-2">No options.</p>;
}

function Row({
  w,
  update,
  remove,
}: {
  w: WidgetConfig;
  update: (w: WidgetConfig) => void;
  remove: () => void;
}) {
  const def = WIDGETS[w.type];
  const Icon = def.icon;
  const [open, setOpen] = useState(false);
  return (
    <Reorder.Item value={w} className="rounded-[16px] bg-[var(--hairline)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <GripVertical
          className="size-4 shrink-0 cursor-grab text-ink-2 active:cursor-grabbing"
          strokeWidth={1.5}
        />
        <Icon
          className="size-[18px] shrink-0"
          style={{ color: `color-mix(in srgb, var(--cat-${CATEGORY[w.type]}) 72%, var(--text))` }}
          strokeWidth={1.5}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] text-ink">
          {def.name} <span className="text-xs text-ink-2">· {CATEGORY_LABEL[CATEGORY[w.type]]}</span>
        </span>
        <div
          role="radiogroup"
          aria-label={`${def.name} size`}
          className="hidden gap-0.5 rounded-full bg-[var(--hairline)] p-0.5 sm:flex"
        >
          {(["compact", "expanded"] as const).map((size) => (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={w.size === size}
              onClick={() => update({ ...w, size })}
              className={`rounded-full px-2.5 py-0.5 text-xs ${w.size === size ? "bg-accent-fill text-on-accent" : "text-ink-2"}`}
            >
              {size === "compact" ? "Compact" : "Expanded"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => update({ ...w, lock: !w.lock })}
          aria-pressed={w.lock}
          title={w.lock ? "Shown on the lock screen" : "Hidden on the lock screen"}
          className={`grid size-8 place-items-center rounded-full ${w.lock ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:text-ink"}`}
          aria-label={`Show ${def.name} on the lock screen`}
        >
          {w.lock ? (
            <Lock className="size-4" strokeWidth={1.5} />
          ) : (
            <LockOpen className="size-4" strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="grid size-8 place-items-center rounded-full text-ink-2 hover:text-ink"
          aria-label={`${def.name} options`}
        >
          <ChevronDown className={`size-4 transition ${open ? "rotate-180" : ""}`} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={remove}
          className="grid size-8 place-items-center rounded-full text-ink-2 hover:text-danger-ink"
          aria-label={`Remove ${def.name}`}
        >
          <Trash2 className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-3 px-11 pt-1 pb-4">
              <div className="flex gap-0.5 self-start rounded-full bg-[var(--hairline)] p-0.5 sm:hidden">
                {(["compact", "expanded"] as const).map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => update({ ...w, size })}
                    className={`rounded-full px-2.5 py-0.5 text-xs ${w.size === size ? "bg-accent-fill text-on-accent" : "text-ink-2"}`}
                  >
                    {size === "compact" ? "Compact" : "Expanded"}
                  </button>
                ))}
              </div>
              <Options w={w} update={update} />
              {w.lock && LOCK_NOTE[w.type] && <p className="text-xs text-ink-2">{LOCK_NOTE[w.type]}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Reorder.Item>
  );
}

export function TaskbarSection() {
  const widgets = useWidgets((s) => s.widgets);
  const save = useWidgets((s) => s.save);
  const full = widgets.length >= MAX_WIDGETS;
  const update = (next: WidgetConfig) => void save(widgets.map((w) => (w.id === next.id ? next : w)));
  return (
    <>
      <p className="py-4 text-sm text-ink-2">
        Widgets sit after the center island, grouped into colored islands by kind: Ember, system, network,
        time and weather, media, updates and notifications. Islands follow the order of their first widget
        here; drag to reorder. The lock icon decides what shows on the lock screen. Sensitive details never
        show there.
      </p>
      <Reorder.Group
        axis="y"
        values={widgets}
        onReorder={(list) => void save(list)}
        className="flex flex-col gap-2"
      >
        {widgets.map((w) => (
          <Row
            key={w.id}
            w={w}
            update={update}
            remove={() => void save(widgets.filter((x) => x.id !== w.id))}
          />
        ))}
      </Reorder.Group>
      <h3 className="heading-display mt-8 mb-3 text-xl text-ink">Library</h3>
      {full && (
        <p className="mb-3 text-sm text-ink-2">
          The taskbar holds {MAX_WIDGETS} widgets. Remove one to add another.
        </p>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(Object.keys(WIDGETS) as WidgetType[]).map((type) => {
          const def = WIDGETS[type];
          const Icon = def.icon;
          const used = widgets.some((w) => w.type === type);
          return (
            <button
              key={type}
              type="button"
              disabled={full}
              onClick={() => void save([...widgets, newWidget(type)])}
              className="hover-lift flex items-center gap-3 rounded-[16px] border border-[var(--hairline-strong)] px-3 py-2.5 text-left disabled:opacity-50"
            >
              <Icon
                className="size-[18px] shrink-0"
                style={{ color: `color-mix(in srgb, var(--cat-${CATEGORY[type]}) 72%, var(--text))` }}
                strokeWidth={1.5}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink">
                  {def.name}
                  {used && <span className="text-ink-2"> · added</span>}
                </span>
                <span className="block truncate text-xs text-ink-2">{def.description}</span>
              </span>
              <Plus className="size-4 shrink-0 text-ink-2" strokeWidth={1.5} />
            </button>
          );
        })}
      </div>
    </>
  );
}
