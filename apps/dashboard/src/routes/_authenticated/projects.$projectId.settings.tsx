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

function TriggersSection({ projectId }: { projectId: string }) {
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<{ triggers: string | null }>(`/projects/${projectId}`),
  });

  let triggers: { cron: string[]; queue: boolean } | null = null;
  try {
    if (project?.triggers && typeof project.triggers === "string") {
      triggers = JSON.parse(project.triggers);
    }
  } catch {}

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
            {triggers!.cron.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Cron Schedules</p>
                {triggers!.cron.map((schedule: string, i: number) => (
                  <div key={i} className="rounded bg-code-bg px-2 py-1 font-mono text-xs">
                    {schedule}
                  </div>
                ))}
              </div>
            )}
            {triggers!.queue && (
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-green-500" />
                <span className="text-sm">Queue enabled</span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function GeneralSettings({ projectId }: { projectId: string }) {
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<{ slug: string; productionBranch: string }>(`/projects/${projectId}`),
  });

  const [branch, setBranch] = useState(project?.productionBranch ?? "main");

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        General
      </h2>
      <div className="space-y-4 rounded-lg border border-border p-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Project Name</label>
          <Input value={project?.slug ?? projectId} disabled className="opacity-60" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Production Branch</label>
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
          />
        </div>
      </div>
    </section>
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
