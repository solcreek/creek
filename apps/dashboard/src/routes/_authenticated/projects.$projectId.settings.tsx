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
  const queryClient = useQueryClient();
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<{ triggers: string | null }>(`/projects/${projectId}`),
  });

  let triggers: { cron: string[]; queue: boolean } = { cron: [], queue: false };
  try {
    if (project?.triggers && typeof project.triggers === "string") {
      triggers = JSON.parse(project.triggers);
    }
  } catch {}

  const [editing, setEditing] = useState(false);
  const [draftCron, setDraftCron] = useState<string[]>([]);
  const [newSchedule, setNewSchedule] = useState("");
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setDraftCron([...triggers.cron]);
    setEditing(true);
    setError(null);
  };

  const updateMutation = useMutation({
    mutationFn: (cron: string[]) =>
      api<{ ok: boolean; cron: string[] }>(`/projects/${projectId}/triggers`, {
        method: "PATCH",
        body: JSON.stringify({ cron }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      setEditing(false);
      setNewSchedule("");
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Triggers
      </h2>
      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Cron Schedules</p>
          {!editing && (
            <Button variant="ghost" size="sm" onClick={startEdit}>
              Edit
            </Button>
          )}
        </div>

        {editing ? (
          <div className="space-y-2">
            {draftCron.map((schedule, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={schedule}
                  onChange={(e) => {
                    const next = [...draftCron];
                    next[i] = e.target.value;
                    setDraftCron(next);
                  }}
                  className="font-mono text-xs"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraftCron(draftCron.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Input
                value={newSchedule}
                onChange={(e) => setNewSchedule(e.target.value)}
                placeholder="0 */6 * * *"
                className="font-mono text-xs"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (newSchedule.trim()) {
                    setDraftCron([...draftCron, newSchedule.trim()]);
                    setNewSchedule("");
                  }
                }}
              >
                Add
              </Button>
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex items-center gap-2 pt-2">
              <Button
                size="sm"
                onClick={() => updateMutation.mutate(draftCron)}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
            <p className="pt-2 text-xs text-muted-foreground">
              Changes apply immediately. Note: next <code className="rounded bg-code-bg px-1">creek deploy</code> will overwrite with values from creek.toml.
            </p>
          </div>
        ) : triggers.cron.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No cron schedules. Add <code className="rounded bg-code-bg px-1">[triggers].cron</code> to creek.toml or click Edit.
          </p>
        ) : (
          <div className="space-y-1">
            {triggers.cron.map((schedule, i) => (
              <div key={i} className="rounded bg-code-bg px-2 py-1 font-mono text-xs">
                {schedule}
              </div>
            ))}
          </div>
        )}

        {triggers.queue && (
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <span className="size-2 rounded-full bg-green-500" />
            <span className="text-sm">Queue enabled</span>
          </div>
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
