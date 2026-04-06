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
