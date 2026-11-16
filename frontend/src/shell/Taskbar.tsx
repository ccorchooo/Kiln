import { AnimatePresence, motion, Reorder } from "framer-motion";
import { ChevronDown, LayoutGrid, Plus, Search } from "lucide-react";
import { KilnGlyph } from "../components/Brand";
import { useState, type MouseEvent, type ReactNode } from "react";
import { spring } from "../components/motion";
import { useWidgets } from "../widgets/store";
import { WidgetIslands } from "../widgets/Islands";
import { APPS } from "./apps";
import { useWM } from "./wm";

function IslandButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`hover-lift grid size-9 place-items-center rounded-full ${active ? "bg-accent-fill text-on-accent" : "text-ink-2 hover:text-ink"}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {children}
    </button>
  );
}

/** Center island: Home / Search / Task view; becomes the 1 2 3 + counter in task view. */
export function CenterIsland({ extra }: { extra?: ReactNode }) {
  const taskView = useWM((s) => s.taskView);
  const current = useWM((s) => s.current);
  const workspaces = useWM((s) => s.workspaces);
  const spotlight = useWM((s) => s.spotlight);
  const wm = useWM.getState;
  return (
    <motion.nav
      layoutId="primary-pill"
      layout
      transition={spring}
      className="glass flex h-12 shrink-0 items-center gap-1 rounded-full px-1.5"
      aria-label={taskView ? "Workspaces" : "Navigation"}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {taskView ? (
          <motion.div
            key="counter"
            className="flex items-center gap-1"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={spring}
          >
            <IslandButton label="Home" active={current === -1} onClick={() => wm().goTo(-1)}>
              <KilnGlyph className={`size-5 ${current === -1 ? "" : "text-accent-ink"}`} />
            </IslandButton>
            <Reorder.Group
              as="div"
              axis="x"
              values={workspaces.map((w) => w.id)}
              onReorder={(ids) => wm().reorderWorkspaces(ids)}
              className="flex items-center gap-1"
            >
              {workspaces.map((w, i) => (
                <Reorder.Item
                  as="div"
                  key={w.id}
                  value={w.id}
                  className="cursor-grab active:cursor-grabbing"
                  whileDrag={{ scale: 1.1 }}
                >
                  <button
                    type="button"
                    onClick={() => wm().goTo(i)}
                    className={`num grid size-9 place-items-center rounded-full text-sm transition ${i === current ? "bg-accent-fill text-on-accent" : "text-ink-2 hover:text-ink"}`}
                    aria-label={`Workspace ${i + 1}`}
                    aria-current={i === current}
                  >
                    {i + 1}
                  </button>
                </Reorder.Item>
              ))}
            </Reorder.Group>
            <IslandButton label="New workspace" onClick={() => wm().addWorkspace()}>
              <Plus className="size-[18px]" strokeWidth={1.5} />
            </IslandButton>
          </motion.div>
        ) : (
          <motion.div
            key="buttons"
            className="flex items-center gap-1"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={spring}
          >
            <IslandButton
              label="Search (Ctrl+Space)"
              active={spotlight}
              onClick={() => wm().setSpotlight(!spotlight)}
            >
              <Search className="size-[18px]" strokeWidth={1.5} />
            </IslandButton>
            {/* Home is the Kiln logo, in the middle of the island. */}
            <IslandButton label="Home" active={current === -1} onClick={() => wm().goTo(-1)}>
              <KilnGlyph className={`size-5 ${current === -1 ? "" : "text-accent-ink"}`} />
            </IslandButton>
            <IslandButton label="Task view (Ctrl+Alt+Tab)" onClick={() => wm().setTaskView(true)}>
              <LayoutGrid className="size-[18px]" strokeWidth={1.5} />
            </IslandButton>
            {extra}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}

function DockItem({ appId }: { appId: string }) {
  const app = APPS[appId]!;
  const Icon = app.icon;
  const windows = useWM((s) => s.windows);
  const ws = useWM((s) => s.workspaces[s.current]);
  const [menu, setMenu] = useState(false);
  const running = Object.values(windows).filter((w) => w.appId === appId);
  const active = !!ws && ws.windows.some((id) => windows[id]?.appId === appId);

  const open = (e: MouseEvent) => {
    const wm = useWM.getState();
    if (e.shiftKey || e.button === 1 || running.length === 0) {
      wm.openApp(appId, { newWorkspace: e.shiftKey || e.button === 1 });
      return;
    }
    // Cycle through this app's windows.
    const focused = ws?.focused;
    const i = running.findIndex((w) => w.id === focused);
    wm.focusWindow(running[(i + 1) % running.length]!.id);
  };

  return (
    <Reorder.Item as="div" value={appId} className="relative" whileDrag={{ scale: 1.12, zIndex: 2 }}>
      <button
        type="button"
        onClick={open}
        onAuxClick={open}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
        className={`hover-lift relative grid size-9 place-items-center rounded-full ${active ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:text-ink"}`}
        aria-label={`${app.name}${running.length ? ` (${running.length} open)` : ""}`}
        title={app.name}
      >
        <Icon className="size-[18px]" strokeWidth={1.5} />
        {running.length > 0 && (
          <span className="absolute bottom-0.5 size-1 rounded-full bg-accent" aria-hidden />
        )}
      </button>
      <AnimatePresence>
        {menu && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setMenu(false)}
              onContextMenu={(e) => (e.preventDefault(), setMenu(false))}
            />
            <motion.div
              className="glass absolute bottom-12 left-1/2 z-50 w-44 -translate-x-1/2 rounded-[16px] p-1.5"
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={spring}
              role="menu"
            >
              <button
                role="menuitem"
                type="button"
                className="w-full rounded-[10px] px-3 py-2 text-left text-sm text-ink hover:bg-[var(--hairline)]"
                onClick={() => {
                  useWM.getState().openApp(appId, { newWorkspace: true });
                  setMenu(false);
                }}
              >
                {app.multiInstance ? "New window" : "Open"}
              </button>
              <button
                role="menuitem"
                type="button"
                className="w-full rounded-[10px] px-3 py-2 text-left text-sm text-ink hover:bg-[var(--hairline)]"
                onClick={() => {
                  useWM.getState().togglePin(appId);
                  setMenu(false);
                }}
              >
                Unpin from dock
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </Reorder.Item>
  );
}

export function DockApps() {
  const pinned = useWM((s) => s.pinned);
  return (
    <Reorder.Group
      as="div"
      axis="x"
      values={pinned}
      onReorder={(ids) => useWM.getState().setPinned(ids)}
      className="flex items-center gap-1"
    >
      {pinned.map((id) => (
        <DockItem key={id} appId={id} />
      ))}
    </Reorder.Group>
  );
}

const fold = {
  initial: { opacity: 0, x: 80, scale: 0.85 },
  animate: { opacity: 1, x: 0, scale: 1 },
  exit: { opacity: 0, x: 80, scale: 0.85, transition: { duration: 0.25 } },
};

export function Taskbar({ mobile }: { mobile: boolean }) {
  const current = useWM((s) => s.current);
  const taskView = useWM((s) => s.taskView);
  const orbInPill = current !== -1 || taskView;
  const [sheet, setSheet] = useState(false);
  const widgets = useWidgets((s) => s.widgets);

  if (mobile) {
    return (
      <>
        <motion.div
          className="pointer-events-none fixed inset-x-0 bottom-[max(10px,env(safe-area-inset-bottom))] z-30 flex justify-center px-2"
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
        >
          <div className="pointer-events-auto flex max-w-full items-center gap-1.5">
            <CenterIsland
              extra={
                <IslandButton label="Widgets" active={sheet} onClick={() => setSheet(!sheet)}>
                  <ChevronDown
                    className={`size-[18px] transition ${sheet ? "" : "rotate-180"}`}
                    strokeWidth={1.5}
                  />
                </IslandButton>
              }
            />
            <motion.div
              {...fold}
              transition={spring}
              className="glass no-scrollbar flex h-12 min-w-0 items-center overflow-x-auto rounded-full px-1.5"
            >
              <DockApps />
            </motion.div>
          </div>
        </motion.div>
        <AnimatePresence>
          {sheet && (
            <motion.div
              className="fixed inset-x-2 top-[max(8px,env(safe-area-inset-top))] z-40 flex flex-wrap justify-center gap-2"
              initial={{ y: -80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -80, opacity: 0 }}
              transition={spring}
              drag="y"
              dragConstraints={{ top: 0, bottom: 0 }}
              onDragEnd={(_, info) => info.offset.y < -40 && setSheet(false)}
            >
              <WidgetIslands
                widgets={widgets}
                interactive
                withOrb={orbInPill}
                placement="down"
                layout="wrap"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  return (
    // On lock, the outgoing bar fades fast; the shared pills (island → password, tray → lock row)
    // carry the motion via layoutId.
    <motion.div
      className="pointer-events-none fixed inset-x-3 bottom-3 z-30 flex items-center gap-3"
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
    >
      <motion.div
        {...fold}
        transition={spring}
        className="glass pointer-events-auto flex h-12 shrink-0 items-center rounded-full px-1.5"
        aria-label="Dock"
      >
        <DockApps />
      </motion.div>
      <div className="pointer-events-auto shrink-0">
        <CenterIsland />
      </div>
      {/* Widget islands take the rest of the row; py-2 keeps their hover lift unclipped. */}
      <WidgetIslands
        widgets={widgets}
        interactive
        withOrb={orbInPill}
        layout="row"
        className="pointer-events-auto -my-2 flex-1"
      />
    </motion.div>
  );
}
