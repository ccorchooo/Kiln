import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { withReauth } from "../../components/Reauth";
import { api } from "../../lib/api";
import { toastError } from "../../lib/toasts";
import { bytes } from "../../widgets/format";
import { ConfirmButton, Empty, SearchBox, Tabs } from "./ui";

interface Proc {
  pid: number;
  name: string;
  user: string;
  mine: boolean;
  cpu: number;
  rss: number;
  mem: number;
  cmd: string;
  status: string;
}

type Sort = "cpu" | "mem" | "name";
const SHOWN = 150; // rows rendered; search narrows the rest

export function Processes() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("cpu");
  const [mine, setMine] = useState<"all" | "mine">("all");
  const { data } = useQuery({
    queryKey: ["system", "processes"],
    queryFn: () => api<{ processes: Proc[] }>("/api/system/processes"),
    refetchInterval: 2000,
  });

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (data?.processes ?? []).filter(
      (p) =>
        (mine === "all" || p.mine) &&
        (!needle ||
          p.name.toLowerCase().includes(needle) ||
          p.cmd.toLowerCase().includes(needle) ||
          String(p.pid) === needle),
    );
    list.sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "mem" ? b.rss - a.rss : b.cpu - a.cpu,
    );
    return list;
  }, [data, q, sort, mine]);

  const signal = async (p: Proc, force: boolean) => {
    try {
      await withReauth(`Confirm your password to stop ${p.name}`, () =>
        api(`/api/system/processes/${p.pid}/signal`, { method: "POST", body: { force } }),
      );
      void qc.invalidateQueries({ queryKey: ["system", "processes"] });
    } catch (err) {
      toastError(`Couldn't stop ${p.name}`, err);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} label="Search by name, command or PID" />
        <Tabs
          label="Sort by"
          value={sort}
          onChange={setSort}
          options={[
            ["cpu", "CPU"],
            ["mem", "Memory"],
            ["name", "Name"],
          ]}
        />
        <Tabs
          label="Owner"
          value={mine}
          onChange={setMine}
          options={[
            ["all", "All"],
            ["mine", "Mine"],
          ]}
        />
      </div>
      {!data ? (
        <Empty>Loading…</Empty>
      ) : (
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-xs text-ink-2">
            <tr>
              <th className="py-1.5 pl-2 font-normal">Name</th>
              <th className="w-20 font-normal">PID</th>
              <th className="w-24 font-normal">User</th>
              <th className="w-16 text-right font-normal">CPU</th>
              <th className="w-24 text-right font-normal">Memory</th>
              <th className="w-44" />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, SHOWN).map((p) => (
              <tr key={p.pid} className="group border-t border-hairline hover:bg-[var(--hairline)]">
                <td className="truncate py-1.5 pl-2" title={p.cmd || p.name}>
                  <span className="text-ink">{p.name}</span>
                  {p.cmd && <span className="ml-2 text-xs text-ink-2">{p.cmd}</span>}
                </td>
                <td className="num text-ink-2">{p.pid}</td>
                <td className="truncate text-ink-2">{p.user}</td>
                <td className="num text-right text-ink">{p.cpu.toFixed(1)}%</td>
                <td className="num text-right text-ink">{bytes(p.rss)}</td>
                <td className="text-right">
                  {p.mine && (
                    <span className="inline-flex gap-1 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
                      <ConfirmButton
                        label="Stop"
                        confirm="Stop it?"
                        onConfirm={() => void signal(p, false)}
                      />
                      <ConfirmButton
                        label="Force stop"
                        confirm="Kill it?"
                        danger
                        onConfirm={() => void signal(p, true)}
                      />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > SHOWN && (
        <p className="text-center text-xs text-ink-2">
          Showing {SHOWN} of {rows.length}. Search to narrow it down.
        </p>
      )}
    </div>
  );
}
