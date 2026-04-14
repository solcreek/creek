import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";

/**
 * Logs tab — read the R2-archived per-tenant log stream + optional
 * live tail via WebSocket. Uses the same endpoints as `creek logs`:
 *
 *   GET /projects/:slug/logs           — historical query
 *   GET /projects/:slug/logs/ws-token  — mint a 5-min subscribe token
 *
 * Tenant isolation is enforced server-side — the prefix and team
 * are derived from the authenticated session, not URL params.
 */

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/logs",
)({
  component: LogsTab,
});

type Outcome =
  | "ok"
  | "exception"
  | "exceededCpu"
  | "exceededMemory"
  | "canceled"
  | "responseStreamDisconnected"
  | "scriptNotFound"
  | "unknown";

type Level = "log" | "warn" | "error" | "info" | "debug";

interface LogEntry {
  v: 1;
  timestamp: number;
  team: string;
  project: string;
  scriptType: "production" | "branch" | "deployment";
  branch?: string;
  deployId?: string;
  outcome: Outcome;
  request?: { url: string; method: string; status?: number };
  logs: Array<{ level: Level; message: unknown[]; timestamp: number }>;
  exceptions: Array<{ name: string; message: string; timestamp: number }>;
}

interface LogsResponse {
  entries: LogEntry[];
  truncated: boolean;
  query: { sinceMs: number; untilMs: number; limit: number };
}

type Range = "15m" | "1h" | "6h" | "24h";

function LogsTab() {
  const { projectId } = Route.useParams();
  const [range, setRange] = useState<Range>("1h");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(false);
  const [liveEntries, setLiveEntries] = useState<LogEntry[]>([]);

  const historical = useQuery({
    queryKey: ["logs", projectId, range, errorsOnly, search],
    queryFn: () => {
      const params = new URLSearchParams({ since: range, limit: "200" });
      if (errorsOnly) params.set("outcome", "exception");
      if (search.trim()) params.set("search", search.trim());
      return api<LogsResponse>(
        `/projects/${projectId}/logs?${params.toString()}`,
      );
    },
    // Don't poll when live-tailing; WS is authoritative.
    refetchInterval: live ? false : 30_000,
  });

  // Merge historical + live, dedup by (timestamp, request.url, method).
  const merged = useMemo(() => {
    const all = [...(historical.data?.entries ?? []), ...liveEntries];
    const seen = new Set<string>();
    const uniq: LogEntry[] = [];
    for (const e of all) {
      const key = `${e.timestamp}:${e.request?.url ?? ""}:${e.request?.method ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(e);
    }
    // Newest first in the UI.
    return uniq.sort((a, b) => b.timestamp - a.timestamp);
  }, [historical.data?.entries, liveEntries]);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {(["15m", "1h", "6h", "24h"] as const).map((r) => (
            <Button
              key={r}
              variant={range === r ? "default" : "ghost"}
              size="sm"
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>
        <Button
          variant={errorsOnly ? "default" : "ghost"}
          size="sm"
          onClick={() => setErrorsOnly((v) => !v)}
        >
          Errors only
        </Button>
        <input
          type="search"
          placeholder="Search messages, exceptions, URLs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-0 rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground"
        />
        <Button
          variant={live ? "default" : "ghost"}
          size="sm"
          onClick={() => {
            setLive((v) => !v);
            if (!live) setLiveEntries([]); // reset buffer on enable
          }}
        >
          {live ? "● Live" : "Live tail"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Logs capture worker invocations only — requests served from CF edge
        cache don't appear here.{" "}
        <Link
          to="/projects/$projectId/analytics"
          params={{ projectId }}
          className="underline hover:text-foreground"
        >
          See Analytics
        </Link>{" "}
        for total traffic including cache hits.
      </p>

      {live && (
        <LiveTail
          projectId={projectId}
          errorsOnly={errorsOnly}
          search={search}
          onEntry={(entry) =>
            setLiveEntries((prev) => {
              // Bound the in-memory buffer so long sessions don't OOM.
              const next = [...prev, entry];
              return next.length > 500 ? next.slice(-500) : next;
            })
          }
        />
      )}

      {historical.isLoading && !historical.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : merged.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No log entries match. Try widening the range or clearing filters.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {merged.map((entry, i) => (
            <LogEntryRow key={`${entry.timestamp}-${i}`} entry={entry} />
          ))}
          {historical.data?.truncated && !live && (
            <p className="mt-2 text-xs text-muted-foreground">
              Truncated to {historical.data.entries.length} entries — narrow the
              range to see more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LiveTail({
  projectId,
  errorsOnly,
  search,
  onEntry,
}: {
  projectId: string;
  errorsOnly: boolean;
  search: string;
  onEntry: (entry: LogEntry) => void;
}) {
  const [status, setStatus] = useState<"connecting" | "connected" | "closed">(
    "connecting",
  );
  // Keep latest filter values in a ref so the WS effect doesn't teardown
  // the connection on every keystroke in the search field.
  const filterRef = useRef({ errorsOnly, search });
  filterRef.current = { errorsOnly, search };

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    async function connect() {
      if (stopped) return;
      try {
        setStatus("connecting");
        const minted = await api<{ wsUrl: string; expiresAt: number }>(
          `/projects/${projectId}/logs/ws-token`,
        );
        if (stopped) return;
        ws = new WebSocket(minted.wsUrl);
        ws.addEventListener("open", () => {
          setStatus("connected");
          // Clean reconnect ~30s before token expiry.
          const msToExpiry = Math.max(5_000, minted.expiresAt - Date.now() - 30_000);
          refreshTimer = setTimeout(() => ws?.close(1000, "refresh"), msToExpiry);
        });
        ws.addEventListener("message", (ev) => {
          let parsed: { type?: string; entry?: LogEntry };
          try {
            parsed = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (parsed.type !== "log" || !parsed.entry) return;
          const entry = parsed.entry;
          const { errorsOnly: eo, search: s } = filterRef.current;
          if (eo && entry.outcome === "ok" && entry.exceptions.length === 0) return;
          if (s.trim()) {
            const n = s.trim().toLowerCase();
            const hay =
              entry.logs
                .flatMap((l) =>
                  l.message.map((m) =>
                    typeof m === "string" ? m : safeStringify(m),
                  ),
                )
                .join(" ") +
              " " +
              entry.exceptions.map((e) => `${e.name} ${e.message}`).join(" ") +
              " " +
              (entry.request?.url ?? "");
            if (!hay.toLowerCase().includes(n)) return;
          }
          onEntry(entry);
        });
        ws.addEventListener("close", () => {
          setStatus("closed");
          if (refreshTimer) clearTimeout(refreshTimer);
          if (!stopped) {
            // Backoff-free retry — realtime-worker intentionally closes on
            // refresh; that's a clean path, not a failure.
            reconnectTimer = setTimeout(connect, 500);
          }
        });
        ws.addEventListener("error", () => {
          // close will fire after.
        });
      } catch {
        if (stopped) return;
        setStatus("closed");
        reconnectTimer = setTimeout(connect, 2_000);
      }
    }

    connect();

    return () => {
      stopped = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close(1000, "unmount");
      } catch {
        // already closed
      }
    };
  }, [projectId, onEntry]);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          status === "connected"
            ? "bg-green-500 animate-pulse"
            : status === "connecting"
              ? "bg-yellow-500"
              : "bg-red-500"
        }`}
      />
      Live tail: {status}
    </div>
  );
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = entry.logs.length > 0 || entry.exceptions.length > 0;
  const ts = new Date(entry.timestamp);
  const tsLabel = ts.toLocaleString();

  const status = entry.request?.status;
  const statusBucket =
    status === undefined
      ? ""
      : status >= 500
        ? "bg-red-500/10 text-red-400 border-red-500/30"
        : status >= 400
          ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
          : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";

  const outcomeLabel =
    entry.outcome === "ok"
      ? null
      : entry.outcome === "exception"
        ? "exception"
        : entry.outcome;

  const path = useMemo(() => {
    if (!entry.request?.url) return "—";
    try {
      const u = new URL(entry.request.url);
      return u.pathname + u.search;
    } catch {
      return entry.request.url;
    }
  }, [entry.request?.url]);

  const variant =
    entry.scriptType === "production"
      ? null
      : entry.scriptType === "branch"
        ? `branch · ${entry.branch}`
        : `deploy · ${entry.deployId}`;

  return (
    <div className="rounded-md border border-border bg-code-bg/50 text-xs">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={`flex w-full items-center gap-3 px-3 py-1.5 text-left ${
          hasDetail ? "hover:bg-code-bg cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {tsLabel}
        </span>
        <span className="shrink-0 font-mono text-muted-foreground">
          {entry.request?.method ?? "—"}
        </span>
        <span className="flex-1 truncate font-mono">{path}</span>
        {status !== undefined && (
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 font-mono tabular-nums ${statusBucket}`}
          >
            {status}
          </span>
        )}
        {outcomeLabel && (
          <span className="shrink-0 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-red-400">
            {outcomeLabel}
          </span>
        )}
        {variant && (
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-muted-foreground">
            {variant}
          </span>
        )}
        {hasDetail && (
          <span className="shrink-0 text-muted-foreground">{expanded ? "−" : "+"}</span>
        )}
      </button>
      {hasDetail && expanded && (
        <div className="border-t border-border px-3 py-2 space-y-1 font-mono">
          {entry.logs.map((l, i) => (
            <div key={`l${i}`} className="flex gap-2">
              <span
                className={`shrink-0 uppercase ${
                  l.level === "error"
                    ? "text-red-400"
                    : l.level === "warn"
                      ? "text-amber-400"
                      : "text-cyan-400"
                }`}
              >
                {l.level}
              </span>
              <span className="whitespace-pre-wrap break-words">
                {l.message
                  .map((m) => (typeof m === "string" ? m : safeStringify(m)))
                  .join(" ")}
              </span>
            </div>
          ))}
          {entry.exceptions.map((e, i) => (
            <div key={`e${i}`} className="flex gap-2 text-red-400">
              <span className="shrink-0 uppercase">exc</span>
              <span className="whitespace-pre-wrap break-words">
                {e.name}: {e.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
