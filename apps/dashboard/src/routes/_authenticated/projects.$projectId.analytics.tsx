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

type Period = "1h" | "6h" | "24h" | "7d" | "30d";

interface PerformanceTotals {
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeP50: number;
  cpuTimeP99: number;
}

interface PerformanceResponse {
  scriptName: string;
  period: Period;
  totals: PerformanceTotals;
  series: unknown[];
}

interface TrafficResponse {
  period: Period;
  totals: {
    reqs: number; // zone-level (includes edge-cached) with AE fallback
    cachedReqs: number; // subset served from CF edge cache
    invocations: number; // worker runs (AE)
    errs: number;
  };
  series: { t: number; reqs: number; errs: number }[];
  httpSeries:
    | { t: number; reqs: number; cachedReqs: number }[]
    | null;
  breakdowns: {
    method: { label: string; reqs: number; errs: number }[];
    scriptType: { label: string; reqs: number; errs: number }[];
    statusBucket: { label: string; reqs: number; errs: number }[];
  };
}

function AnalyticsTab() {
  const { projectId } = Route.useParams();
  const [period, setPeriod] = useState<Period>("24h");

  // Traffic = AE (our tail-worker dataset — covers prod + branch + preview,
  // richer breakdowns). Primary source for requests / errors / time series.
  const traffic = useQuery({
    queryKey: ["traffic", projectId, period],
    queryFn: () =>
      api<TrafficResponse>(`/projects/${projectId}/metrics?period=${period}`),
    refetchInterval: 60_000,
  });

  // Performance = CF GraphQL (production scriptName only — but gives
  // CPU p50/p99 quantiles and subrequest counts that AE doesn't track).
  const performance = useQuery({
    queryKey: ["performance", projectId, period],
    queryFn: () =>
      api<PerformanceResponse>(
        `/projects/${projectId}/analytics?period=${period}`,
      ),
    refetchInterval: 60_000,
  });

  // Cron invocation log (only if project has cron triggers)
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

  const reqs = traffic.data?.totals.reqs ?? 0;
  const cachedReqs = traffic.data?.totals.cachedReqs ?? 0;
  const invocations = traffic.data?.totals.invocations ?? 0;
  const errs = traffic.data?.totals.errs ?? 0;
  // Error rate is computed over invocations (errors only fire when the
  // worker runs); quoting it against total reqs would dilute it with
  // edge-cache hits that physically can't error.
  const errorRate = invocations > 0 ? (errs / invocations) * 100 : 0;
  const cacheHitRate = reqs > 0 ? (cachedReqs / reqs) * 100 : 0;
  const perfTotals = performance.data?.totals;

  return (
    <div className="space-y-6">
      <div className="flex gap-1">
        {(["1h", "6h", "24h", "7d", "30d"] as const).map((p) => (
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

      {traffic.isLoading && performance.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Requests" value={formatNumber(reqs)} />
            <StatCard
              label="Cache hit"
              value={reqs > 0 ? `${cacheHitRate.toFixed(0)}%` : "—"}
              hint={cachedReqs > 0 ? formatNumber(cachedReqs) : undefined}
            />
            <StatCard
              label="Invocations"
              value={formatNumber(invocations)}
              hint="worker runs"
            />
            <StatCard
              label="Error rate"
              value={`${errorRate.toFixed(2)}%`}
              variant={errorRate >= 1 ? "error" : "default"}
              hint={errs > 0 ? `${formatNumber(errs)} errs` : undefined}
            />
            <StatCard
              label="CPU p50"
              value={perfTotals ? `${perfTotals.cpuTimeP50.toFixed(1)}ms` : "—"}
              hint="production"
            />
            <StatCard
              label="CPU p99"
              value={perfTotals ? `${perfTotals.cpuTimeP99.toFixed(1)}ms` : "—"}
              hint="production"
            />
          </div>

          {traffic.data?.httpSeries && traffic.data.httpSeries.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                Requests over time
              </h3>
              <HttpRequestsChart series={traffic.data.httpSeries} />
            </div>
          ) : traffic.data && traffic.data.series.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                Worker invocations over time
              </h3>
              <RequestsChart series={traffic.data.series} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No traffic in this period.
              </p>
            </div>
          )}

          {traffic.data && traffic.data.totals.reqs > 0 && (
            <div className="grid gap-6 lg:grid-cols-3">
              <BreakdownList
                title="By method"
                rows={traffic.data.breakdowns.method}
              />
              <BreakdownList
                title="By deployment type"
                rows={traffic.data.breakdowns.scriptType}
              />
              <BreakdownList
                title="By status"
                rows={traffic.data.breakdowns.statusBucket}
              />
            </div>
          )}

          {perfTotals && perfTotals.subrequests > 0 && (
            <p className="text-xs text-muted-foreground">
              {formatNumber(perfTotals.subrequests)} subrequests (production
              only)
            </p>
          )}

          {hasCron && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                Cron execution log (24h)
              </h3>
              <CronLogsPanel projectId={projectId} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  variant = "default",
  hint,
}: {
  label: string;
  value: string;
  variant?: "default" | "error";
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted-foreground">
        {label}
        {hint && (
          <span className="ml-1 text-[10px] uppercase tracking-wide opacity-70">
            {hint}
          </span>
        )}
      </p>
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

function HttpRequestsChart({
  series,
}: {
  series: { t: number; reqs: number; cachedReqs: number }[];
}) {
  const entries = [...series].sort((a, b) => a.t - b.t);
  const maxReqs = Math.max(...entries.map((s) => s.reqs), 1);

  return (
    <div
      className="flex items-end gap-px overflow-x-auto"
      style={{ height: 120 }}
    >
      {entries.map((s) => {
        const totalH = Math.max((s.reqs / maxReqs) * 100, 2);
        const cachedH =
          s.reqs > 0 ? (s.cachedReqs / maxReqs) * 100 : 0;
        const originH = Math.max(totalH - cachedH, 0);
        const label = new Date(s.t).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });

        return (
          <div
            key={s.t}
            className="group relative flex flex-1 flex-col items-center justify-end"
            style={{ minWidth: 4, height: "100%" }}
            title={`${label}: ${formatNumber(s.reqs)} total (${formatNumber(s.cachedReqs)} cached)`}
          >
            <div
              className="w-full rounded-t bg-blue-500"
              style={{ height: `${originH}%`, minHeight: 1 }}
            />
            {cachedH > 0 && (
              <div
                className="w-full bg-blue-500/30"
                style={{ height: `${cachedH}%`, minHeight: 1 }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function RequestsChart({
  series,
}: {
  series: { t: number; reqs: number; errs: number }[];
}) {
  const entries = [...series].sort((a, b) => a.t - b.t);
  const maxReqs = Math.max(...entries.map((s) => s.reqs), 1);

  return (
    <div
      className="flex items-end gap-px overflow-x-auto"
      style={{ height: 120 }}
    >
      {entries.map((s) => {
        const height = Math.max((s.reqs / maxReqs) * 100, 2);
        const errorHeight =
          s.errs > 0 ? Math.max((s.errs / maxReqs) * 100, 2) : 0;
        const label = new Date(s.t).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });

        return (
          <div
            key={s.t}
            className="group relative flex flex-1 flex-col items-center justify-end"
            style={{ minWidth: 4, height: "100%" }}
            title={`${label}: ${formatNumber(s.reqs)} req, ${formatNumber(s.errs)} err`}
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

function BreakdownList({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; reqs: number; errs: number }[];
}) {
  const total = rows.reduce((acc, r) => acc + r.reqs, 0);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data.</p>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => {
            const pct = total > 0 ? (r.reqs / total) * 100 : 0;
            return (
              <div key={r.label || "n/a"} className="space-y-0.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono">{r.label || "n/a"}</span>
                  <span className="text-muted-foreground">
                    {formatNumber(r.reqs)}
                    {r.errs > 0 && (
                      <span className="ml-2 text-red-400">
                        {formatNumber(r.errs)} err
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded bg-code-bg">
                  <div
                    className="h-full bg-blue-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
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
      api<{ invocations: CronInvocation[] }>(
        `/projects/${projectId}/cron-logs`,
      ),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground">Loading invocations...</p>
    );
  }

  if (!data?.invocations?.length) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-center">
        <p className="text-xs text-muted-foreground">
          No invocations in the last 24 hours.
        </p>
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
            <span className="text-muted-foreground">
              {inv.durationMs.toFixed(0)}ms
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}
