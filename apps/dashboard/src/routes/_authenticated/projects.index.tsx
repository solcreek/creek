import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listApps, stopApp, restartApp, type AppView } from "@/lib/adapter";
import { useApiMode, useFeatures } from "@/lib/api-context";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { Folder, RotateCw, Square, Loader2 } from "lucide-react";
import { Button } from "@solcreek/ui/components/button";

export const Route = createFileRoute("/_authenticated/projects/")({
  component: ProjectsListPage,
});

function ProjectsListPage() {
  const mode = useApiMode();
  const features = useFeatures();
  const queryClient = useQueryClient();

  const { data: apps, isLoading } = useQuery({
    queryKey: ["apps"],
    queryFn: listApps,
    refetchInterval: mode === "creekd" ? 5000 : false,
  });

  const restart = useMutation({
    mutationFn: (id: string) => restartApp(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["apps"] }),
  });

  const stop = useMutation({
    mutationFn: (id: string) => stopApp(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["apps"] }),
  });

  const title = mode === "creekd" ? "Apps" : "Projects";

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{title}</h1>
        {features.deployments && <NewProjectDialog />}
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : !apps?.length ? (
        <EmptyState mode={mode} />
      ) : (
        <div className="space-y-2">
          {apps.map((app) => (
            <AppRow
              key={app.id}
              app={app}
              mode={mode}
              onRestart={(id) => restart.mutate(id)}
              onStop={(id) => stop.mutate(id)}
              isRestarting={restart.isPending}
              isStopping={stop.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ mode }: { mode: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-secondary">
        <Folder className="size-6 text-muted-foreground" />
      </div>
      <h3 className="font-semibold">
        {mode === "creekd" ? "No apps running" : "No projects yet"}
      </h3>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        {mode === "creekd"
          ? "Deploy an app to this server using the CLI:"
          : "Get started by creating a project here, or initialize one from the CLI:"}
      </p>
      <div className="mx-auto mt-4 max-w-xs space-y-2">
        <div className="rounded-md bg-code-bg px-3 py-2 text-left font-mono text-xs">
          <span className="text-muted-foreground">$</span>{" "}
          {mode === "creekd" ? "creek deploy --server <url>" : "npx creek deploy"}
        </div>
      </div>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-500",
  starting: "bg-yellow-500",
  crash_loop: "bg-red-500",
  stopping: "bg-yellow-500",
  stopped: "bg-gray-500",
  active: "bg-green-500",
  inactive: "bg-gray-500",
};

function fmtUptime(ms: number): string {
  if (ms < 1000) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

function AppRow({
  app,
  mode,
  onRestart,
  onStop,
  isRestarting,
  isStopping,
}: {
  app: AppView;
  mode: string;
  onRestart: (id: string) => void;
  onStop: (id: string) => void;
  isRestarting: boolean;
  isStopping: boolean;
}) {
  const status = String(app.status);

  return (
    <div className="flex items-center justify-between rounded-lg border border-border p-4 transition-colors hover:bg-card">
      <Link
        to="/projects/$projectId"
        params={{ projectId: app.id }}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <span className={`size-2.5 shrink-0 rounded-full ${STATUS_COLORS[status] ?? "bg-gray-400"}`} />
        <div className="min-w-0">
          <p className="font-medium">{app.id}</p>
          <p className="text-sm text-muted-foreground">
            {app.runtime ?? "—"}
            {mode === "creekd" && app.uptime_ms > 0 && (
              <span className="ml-2">{fmtUptime(app.uptime_ms)}</span>
            )}
            {mode === "creekd" && app.restart_count > 0 && (
              <span className="ml-2 text-amber-400">{app.restart_count} restarts</span>
            )}
          </p>
        </div>
      </Link>

      {mode === "creekd" && (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => { e.preventDefault(); onRestart(app.id); }}
            disabled={isRestarting || status !== "running"}
            title="Restart"
          >
            {isRestarting ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => { e.preventDefault(); onStop(app.id); }}
            disabled={isStopping || status === "stopped"}
            title="Stop"
          >
            {isStopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
          </Button>
        </div>
      )}

      {mode === "hosted" && (
        <div className="text-right text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className={`size-2 rounded-full ${STATUS_COLORS[status] ?? "bg-gray-400"}`} />
            {status === "running" ? "Live" : "Not deployed"}
          </span>
        </div>
      )}
    </div>
  );
}
