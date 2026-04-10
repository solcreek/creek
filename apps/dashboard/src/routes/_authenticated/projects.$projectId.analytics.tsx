import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/analytics",
)({
  component: AnalyticsTab,
});

interface AnalyticsTotals {
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeP50: number;
  cpuTimeP99: number;
}

interface AnalyticsSeries {
  timestamp: string;
  status: string;
  requests: number;
  errors: number;
  cpuTimeP50: number;
  cpuTimeP99: number;
}

interface AnalyticsResponse {
  scriptName: string;
  period: string;
  totals: AnalyticsTotals;
  series: AnalyticsSeries[];
}

type Period = "24h" | "7d" | "30d";

function AnalyticsTab() {
  const { projectId } = Route.useParams();
  const [period, setPeriod] = useState<Period>("24h");

  const { data, isLoading } = useQuery({
    queryKey: ["analytics", projectId, period],
    queryFn: () =>
      api<AnalyticsResponse>(`/projects/${projectId}/analytics?period=${period}`),
    refetchInterval: 60_000,
  });

  // Check if project has cron triggers configured
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<{ triggers: string | null }>(`/projects/${projectId}`),
  });

  let hasCron = false;
  try {
    if (project?.triggers && typeof project.triggers === "string") {
      const parsed = JSON.parse(project.triggers) as { cron: string[] };
      hasCron = Array.isArray(parsed.cron) && parsed.cron.length > 0;
    }
  } catch {}

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex gap-1">
        {(["24h", "7d", "30d"] as const).map((p) => (
          <Button
            key={p}
            variant={period === p ? "default" : "ghost"}
            size="sm"
            onClick={() => setPeriod(p)}
          >
            {p}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading analytics...</p>
      ) : data ? (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Requests" value={formatNumber(data.totals.requests)} />
            <StatCard
              label="Errors"
              value={formatNumber(data.totals.errors)}
              variant={data.totals.errors > 0 ? "error" : "default"}
            />
            <StatCard label="CPU p50" value={`${data.totals.cpuTimeP50.toFixed(1)}ms`} />
            <StatCard label="CPU p99" value={`${data.totals.cpuTimeP99.toFixed(1)}ms`} />
          </div>

          {/* Time series chart (bar chart via CSS) */}
          {data.series.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Requests over time</h3>
              <RequestsChart series={data.series} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm text-muted-foreground">No traffic in this period.</p>
            </div>
          )}

          {/* Error breakdown if any */}
          {data.totals.errors > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Error timeline</h3>
              <ErrorTimeline series={data.series} />
            </div>
          )}

          {/* Cron execution log */}
          {hasCron && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Cron execution log (24h)</h3>
              <CronLogsPanel projectId={projectId} />
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No data available.</p>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  variant = "default",
}: {
  label: string;
  value: string;
  variant?: "default" | "error";
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold ${
          variant === "error" ? "text-red-400" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function RequestsChart({ series }: { series: AnalyticsSeries[] }) {
  // Aggregate by timestamp (combine different status entries)
  const buckets = new Map<string, { requests: number; errors: number }>();
  for (const s of series) {
    const existing = buckets.get(s.timestamp) ?? { requests: 0, errors: 0 };
    existing.requests += s.requests;
    existing.errors += s.errors;
    buckets.set(s.timestamp, existing);
  }

  const entries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maxRequests = Math.max(...entries.map(([, v]) => v.requests), 1);

  return (
    <div className="flex items-end gap-px overflow-x-auto" style={{ height: 120 }}>
      {entries.map(([ts, v]) => {
        const height = Math.max((v.requests / maxRequests) * 100, 2);
        const errorHeight = v.errors > 0 ? Math.max((v.errors / maxRequests) * 100, 2) : 0;
        const date = new Date(ts);
        const label = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

        return (
          <div
            key={ts}
            className="group relative flex flex-1 flex-col items-center justify-end"
            style={{ minWidth: 4, height: "100%" }}
            title={`${label}: ${v.requests} req, ${v.errors} err`}
          >
            {errorHeight > 0 && (
              <div
                className="w-full rounded-t bg-red-500/80"
                style={{ height: `${errorHeight}%`, minHeight: 2 }}
              />
            )}
            <div
              className="w-full rounded-t bg-blue-500"
              style={{ height: `${height - errorHeight}%`, minHeight: 1 }}
            />
          </div>
        );
      })}
    </div>
  );
}

function ErrorTimeline({ series }: { series: AnalyticsSeries[] }) {
  const errors = series.filter((s) => s.errors > 0).sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );

  if (!errors.length) return null;

  return (
    <div className="max-h-48 space-y-1 overflow-y-auto">
      {errors.slice(0, 20).map((e, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded bg-code-bg px-2 py-1 text-xs"
        >
          <span className="text-muted-foreground">
            {new Date(e.timestamp).toLocaleString()}
          </span>
          <span className="text-red-400">{e.errors} errors</span>
        </div>
      ))}
    </div>
  );
}

interface CronInvocation {
  datetime: string;
  status: string;
  requests: number;
  errors: number;
  durationMs: number;
}

function CronLogsPanel({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["cron-logs", projectId],
    queryFn: () =>
      api<{ invocations: CronInvocation[] }>(`/projects/${projectId}/cron-logs`),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Loading invocations...</p>;
  }

  if (!data?.invocations?.length) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-center">
        <p className="text-xs text-muted-foreground">No invocations in the last 24 hours.</p>
      </div>
    );
  }

  return (
    <div className="max-h-64 space-y-1 overflow-y-auto">
      {data.invocations.map((inv, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded bg-code-bg px-2 py-1.5 text-xs"
        >
          <span className="text-muted-foreground">
            {new Date(inv.datetime).toLocaleString()}
          </span>
          <span className="flex items-center gap-3">
            {inv.errors > 0 ? (
              <span className="text-red-400">{inv.errors} errors</span>
            ) : (
              <span className="text-green-400">ok</span>
            )}
            <span className="text-muted-foreground">{inv.durationMs.toFixed(0)}ms</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
