import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/settings",
)({
  component: ProjectSettingsTab,
});

function ProjectSettingsTab() {
  const { projectId } = Route.useParams();

  return (
    <div className="max-w-lg space-y-8">
      <GeneralSettings projectId={projectId} />
      <TriggersSection projectId={projectId} />
      <DangerZone projectId={projectId} />
    </div>
  );
}

function GeneralSettings({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<{ slug: string; productionBranch: string }>(`/projects/${projectId}`),
  });

  const [branch, setBranch] = useState(project?.productionBranch ?? "main");
  const [saved, setSaved] = useState(false);

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        General
      </h2>
      <div className="space-y-4 rounded-lg border border-border p-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Project Name</label>
          <Input value={project?.slug ?? projectId} disabled className="opacity-60" />
          <p className="text-xs text-muted-foreground">Project rename is not yet supported.</p>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Production Branch</label>
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
          />
          <p className="text-xs text-muted-foreground">
            Deployments from this branch are automatically promoted to production.
          </p>
        </div>
      </div>
    </section>
  );
}

function TriggersSection({ projectId }: { projectId: string }) {
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      api<{ triggers: string | null }>(`/projects/${projectId}`),
  });

  const triggers = project?.triggers ? JSON.parse(project.triggers) as { cron: string[]; queue: boolean } : null;
  const hasTriggers = triggers && (triggers.cron.length > 0 || triggers.queue);

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Triggers
      </h2>
      <div className="space-y-3 rounded-lg border border-border p-4">
        {!hasTriggers ? (
          <p className="text-sm text-muted-foreground">
            No triggers configured. Add <code className="rounded bg-code-bg px-1">[triggers]</code> to your creek.toml and redeploy.
          </p>
        ) : (
          <>
            {triggers.cron.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Cron Schedules</p>
                <div className="space-y-1">
                  {triggers.cron.map((schedule, i) => (
                    <div key={i} className="rounded bg-code-bg px-2 py-1 font-mono text-xs">
                      {schedule}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Edit cron schedules in your creek.toml and redeploy.
                </p>
                <CronLogs projectId={projectId} />
              </div>
            )}
            {triggers.queue && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Queue</p>
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-green-500" />
                  <span className="text-sm">Enabled</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

interface CronInvocation {
  datetime: string;
  status: string;
  requests: number;
  errors: number;
  durationMs: number;
}

function CronLogs({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["cron-logs", projectId],
    queryFn: () =>
      api<{ invocations: CronInvocation[] }>(`/projects/${projectId}/cron-logs`),
    refetchInterval: 60_000,
  });

  if (isLoading) return <p className="mt-2 text-xs text-muted-foreground">Loading logs...</p>;
  if (!data?.invocations?.length) {
    return <p className="mt-2 text-xs text-muted-foreground">No invocations in the last 24 hours.</p>;
  }

  return (
    <div className="mt-3 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">Recent Invocations (24h)</p>
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {data.invocations.map((inv, i) => (
          <div key={i} className="flex items-center justify-between rounded bg-code-bg px-2 py-1 text-xs">
            <span className="text-muted-foreground">
              {new Date(inv.datetime).toLocaleString()}
            </span>
            <span className="flex items-center gap-2">
              {inv.errors > 0 ? (
                <span className="text-red-400">{inv.errors} errors</span>
              ) : (
                <span className="text-green-400">ok</span>
              )}
              <span className="text-muted-foreground">{inv.durationMs}ms</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DangerZone({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmSlug, setConfirmSlug] = useState("");

  const deleteProject = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate({ to: "/projects" });
    },
  });

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-destructive">
        Danger Zone
      </h2>
      <div className="space-y-4 rounded-lg border border-destructive/30 p-4">
        <div>
          <p className="text-sm font-medium">Delete Project</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This will permanently delete the project, all deployments, environment variables,
            and custom domains. This action cannot be undone.
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">
            Type <code className="rounded bg-code-bg px-1">{projectId}</code> to confirm
          </label>
          <Input
            value={confirmSlug}
            onChange={(e) => setConfirmSlug(e.target.value)}
            placeholder={projectId}
          />
        </div>
        <Button
          variant="destructive"
          size="sm"
          disabled={confirmSlug !== projectId || deleteProject.isPending}
          onClick={() => deleteProject.mutate()}
        >
          {deleteProject.isPending ? "Deleting..." : "Delete Project"}
        </Button>
      </div>
    </section>
  );
}
