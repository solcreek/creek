import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { getApp, getAppStats, restartApp, stopApp, type AppView, type StatsView } from "@/lib/adapter";
import { useApiMode } from "@/lib/api-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@solcreek/ui/components/dropdown-menu";
import { Button } from "@solcreek/ui/components/button";
import { MoreHorizontal, ArrowUpCircle, Rocket, Loader2, ExternalLink, ScrollText, RotateCw, Square } from "lucide-react";
import { BuildLogPanel } from "./-components/BuildLogPanel";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/",
)({
  component: ProjectIndexTab,
});

function ProjectIndexTab() {
  const mode = useApiMode();
  if (mode === "creekd") return <AppOverviewTab />;
  return <DeploymentsTab />;
}

interface Deployment {
  id: string;
  version: number;
  status: string;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  triggerType: string;
  failedStep: string | null;
  errorMessage: string | null;
  createdAt: number;
  productionDeploymentId?: string;
  url: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500",
  queued: "bg-yellow-500",
  uploading: "bg-blue-500",
  provisioning: "bg-blue-500",
  deploying: "bg-blue-500",
  failed: "bg-red-500",
  cancelled: "bg-gray-500",
};

// Statuses that indicate a deployment is still in flight and should trigger
// polling so the dashboard reflects progress without a manual refresh.
const IN_FLIGHT_STATUSES = new Set(["queued", "uploading", "provisioning", "deploying"]);

function DeploymentsTab() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set());
  const toggleLog = (id: string) =>
    setOpenLogs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // After clicking "Deploy latest" we have to poll for a brief window even
  // when the list looks idle — handlePush runs in waitUntil, so the new
  // deployment row may not be visible to the first refetch after the
  // mutation 200s. This flag forces the refetchInterval for a short window.
  const [forcePoll, setForcePoll] = useState(false);
  const forcePollTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (forcePollTimeout.current) clearTimeout(forcePollTimeout.current);
  }, []);

  const { data: deployments, isLoading } = useQuery({
    queryKey: ["deployments", projectId],
    queryFn: () => api<Deployment[]>(`/projects/${projectId}/deployments`),
    // Poll every 2s while any deployment is in flight OR while we're in the
    // post-deploy grace window. Stop otherwise so idle tabs don't burn CPU.
    refetchInterval: (query) => {
      const data = query.state.data as Deployment[] | undefined;
      const hasInFlight = data?.some((d) => IN_FLIGHT_STATUSES.has(d.status));
      return hasInFlight || forcePoll ? 2000 : false;
    },
  });

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<{ productionDeploymentId: string | null; githubRepo: string | null }>(`/projects/${projectId}`),
  });

  const promote = useMutation({
    mutationFn: (deploymentId: string) =>
      api(`/projects/${projectId}/deployments/${deploymentId}/promote`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const deployLatest = useMutation({
    mutationFn: () =>
      api("/github/deploy-latest", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      }),
    onSuccess: () => {
      // Force polling for 15s so we catch the new deployment row as soon as
      // handlePush inserts it (it runs in waitUntil and may land after this
      // response). Once the row shows up with an in-flight status, normal
      // polling takes over.
      if (forcePollTimeout.current) clearTimeout(forcePollTimeout.current);
      setForcePoll(true);
      forcePollTimeout.current = setTimeout(() => setForcePoll(false), 15_000);
      queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
    },
  });

  const hasGithub = !!project?.githubRepo;
  const deployError = (deployLatest.error as Error | null)?.message;

  const DeployButton = () => (
    <Button
      size="sm"
      onClick={() => deployLatest.mutate()}
      disabled={!hasGithub || deployLatest.isPending}
      title={hasGithub ? undefined : "Connect a GitHub repository in Settings to enable deploys"}
    >
      {deployLatest.isPending ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          Triggering...
        </>
      ) : (
        <>
          <Rocket className="mr-2 size-4" />
          Deploy latest
        </>
      )}
    </Button>
  );

  if (isLoading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (!deployments?.length) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Deployments</h2>
          <DeployButton />
        </div>
        {deployError && (
          <p className="text-sm text-destructive">Deploy failed: {deployError}</p>
        )}
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <h3 className="font-semibold">No deployments yet</h3>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            {hasGithub
              ? "Click Deploy latest above to build the current HEAD of your production branch."
              : "Connect a GitHub repository in Settings or run from the CLI:"}
          </p>
          {!hasGithub && (
            <div className="mx-auto mt-3 max-w-xs rounded-md bg-code-bg px-3 py-2 text-left font-mono text-xs">
              <span className="text-muted-foreground">$</span> npx creek deploy
            </div>
          )}
        </div>
      </div>
    );
  }

  const productionId = project?.productionDeploymentId;

  return (
    <div className="space-y-2">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Deployments</h2>
        <DeployButton />
      </div>
      {deployError && (
        <p className="text-sm text-destructive">Deploy failed: {deployError}</p>
      )}
      {deployments.map((d) => {
        const isProduction = d.id === productionId;
        const canPromote = d.status === "active" && !isProduction;

        return (
          <div
            key={d.id}
            className={`rounded-lg border p-3 ${
              d.status === "failed"
                ? "border-destructive/30 bg-destructive/5"
                : "border-border"
            }`}
          >
            <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span
                className={`size-2.5 rounded-full ${STATUS_COLORS[d.status] ?? "bg-gray-400"}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  v{d.version}
                  {d.branch && (
                    <span className="ml-2 text-muted-foreground">{d.branch}</span>
                  )}
                  {d.commitSha && (
                    project?.githubRepo ? (
                      <a
                        href={`https://github.com/${project.githubRepo}/commit/${d.commitSha}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {d.commitSha.slice(0, 7)}
                      </a>
                    ) : (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {d.commitSha.slice(0, 7)}
                      </span>
                    )
                  )}
                  {isProduction && (
                    <span className="ml-2 rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-400">
                      Production
                    </span>
                  )}
                </p>
                {d.commitMessage && (
                  <p
                    className="mt-0.5 max-w-md truncate text-xs text-foreground/80"
                    title={d.commitMessage}
                  >
                    {d.commitMessage.split("\n")[0]}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {d.triggerType} &middot; {d.status}
                  {d.failedStep && ` at ${d.failedStep}`}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {d.url && (
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  title={d.url}
                >
                  {/* show the hostname compactly, trimmed */}
                  <span className="max-w-[240px] truncate font-mono">
                    {d.url.replace(/^https?:\/\//, "")}
                  </span>
                  <ExternalLink className="size-3" />
                </a>
              )}
              <span className="text-xs text-muted-foreground">{d.id.slice(0, 8)}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => toggleLog(d.id)}
                title={openLogs.has(d.id) ? "Hide build log" : "Show build log"}
              >
                <ScrollText className="size-4" />
              </Button>
              {canPromote && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={
                    <Button variant="ghost" size="icon-xs">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  } />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => promote.mutate(d.id)}
                      disabled={promote.isPending}
                    >
                      <ArrowUpCircle className="mr-2 size-4" />
                      {promote.isPending ? "Promoting..." : "Promote to Production"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            </div>

            {/* Failed state: inline error details so the user can see what
                actually broke without having to dig through wrangler tail.
                failedStep indicates the pipeline phase (building / uploading /
                provisioning / deploying), errorMessage carries the upstream
                error text. We keep the same border-styling + red background
                so it's visually distinct from successful rows above. */}
            {d.status === "failed" && (d.errorMessage || d.failedStep) && (
              <div className="mt-3 space-y-1 rounded border border-destructive/20 bg-background/40 p-2.5">
                {d.failedStep && (
                  <p className="text-xs font-medium text-destructive">
                    Failed at <span className="font-mono">{d.failedStep}</span>
                  </p>
                )}
                {d.errorMessage && (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground/80">
                    {d.errorMessage}
                  </pre>
                )}
              </div>
            )}

            {(openLogs.has(d.id) || d.status === "failed") && (
              <BuildLogPanel projectId={projectId} deploymentId={d.id} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- creekd mode: App Overview ---

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + "M";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + "G";
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

const STATUS_BADGE: Record<string, string> = {
  running: "bg-green-500/10 text-green-400 border-green-500/30",
  starting: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  crash_loop: "bg-red-500/10 text-red-400 border-red-500/30",
  stopping: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  stopped: "bg-gray-500/10 text-gray-400 border-gray-500/30",
};

function AppOverviewTab() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();

  const { data: app } = useQuery({
    queryKey: ["app", projectId],
    queryFn: () => getApp(projectId),
    refetchInterval: 2000,
  });

  const { data: stats } = useQuery({
    queryKey: ["app-stats", projectId],
    queryFn: () => getAppStats(projectId),
    refetchInterval: 2000,
  });

  const restart = useMutation({
    mutationFn: () => restartApp(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app", projectId] });
      queryClient.invalidateQueries({ queryKey: ["app-stats", projectId] });
    },
  });

  const stop = useMutation({
    mutationFn: () => stopApp(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app", projectId] });
    },
  });

  if (!app) return <p className="text-muted-foreground">Loading...</p>;

  const status = String(app.status);

  return (
    <div className="space-y-6">
      {/* Status + Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`rounded border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status] ?? ""}`}>
            {status.replace("_", " ")}
          </span>
          <span className="text-sm text-muted-foreground">
            pid {app.pid} &middot; port {app.port}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => restart.mutate()}
            disabled={restart.isPending || status !== "running"}
          >
            {restart.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RotateCw className="mr-2 size-4" />}
            Restart
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => stop.mutate()}
            disabled={stop.isPending || status === "stopped"}
          >
            {stop.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Square className="mr-2 size-4" />}
            Stop
          </Button>
        </div>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Uptime" value={fmtDuration(app.uptime_ms)} />
        <StatCard label="Restarts" value={String(app.restart_count)} alert={app.restart_count > 0} />
        <StatCard label="Health failures" value={String(app.health_failures)} alert={app.health_failures > 0} />
        <StatCard label="Runtime" value={app.runtime ?? "—"} />
      </div>

      {/* cgroup stats */}
      {stats?.cgroup_enabled && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Memory"
            value={stats.memory_current_bytes != null ? fmtBytes(stats.memory_current_bytes) : "—"}
            sub={stats.memory_max_bytes != null && stats.memory_max_bytes > 0 ? `/ ${fmtBytes(stats.memory_max_bytes)}` : undefined}
          />
          <StatCard label="PIDs" value={stats.pids_current != null ? String(stats.pids_current) : "—"} />
          <StatCard label="OOM kills" value={stats.oom_kills != null ? String(stats.oom_kills) : "0"} alert={(stats.oom_kills ?? 0) > 0} />
          <StatCard
            label="CPU time"
            value={stats.cpu_usage_usec != null ? (stats.cpu_usage_usec / 1_000_000).toFixed(1) + "s" : "—"}
          />
        </div>
      )}

      {/* Command */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">Command</h3>
        <div className="rounded-md bg-code-bg px-3 py-2 font-mono text-xs">
          {app.command}{app.args && app.args.length > 0 ? " " + app.args.join(" ") : ""}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, alert }: { label: string; value: string; sub?: string; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${alert ? "text-amber-400" : ""}`}>
        {value}
        {sub && <span className="text-sm font-normal text-muted-foreground"> {sub}</span>}
      </p>
    </div>
  );
}
