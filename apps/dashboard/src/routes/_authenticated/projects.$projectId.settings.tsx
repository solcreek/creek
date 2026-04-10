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
  const [draftQueue, setDraftQueue] = useState(false);
  const [newSchedule, setNewSchedule] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [requiresRedeploy, setRequiresRedeploy] = useState(false);

  const startEdit = () => {
    setDraftCron([...triggers.cron]);
    setDraftQueue(triggers.queue);
    setEditing(true);
    setError(null);
  };

  const updateMutation = useMutation({
    mutationFn: (patch: { cron: string[]; queue: boolean }) =>
      api<{ ok: boolean; cron: string[]; queue: boolean; queueRequiresRedeploy: boolean }>(
        `/projects/${projectId}/triggers`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      setEditing(false);
      setNewSchedule("");
      setError(null);
      setRequiresRedeploy(data.queueRequiresRedeploy);
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

      {/* Persistent warning when queue change requires redeploy */}
      {requiresRedeploy && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
          <span className="text-yellow-400">⚠</span>
          <div className="flex-1">
            <p className="font-medium text-yellow-200">Redeploy required</p>
            <p className="mt-1 text-xs text-yellow-200/80">
              Queue binding changes only take effect after the next deployment. Run{" "}
              <code className="rounded bg-yellow-500/20 px-1">creek deploy</code> from your project directory.
            </p>
          </div>
          <button
            onClick={() => setRequiresRedeploy(false)}
            className="text-xs text-yellow-200/60 hover:text-yellow-200"
          >
            ×
          </button>
        </div>
      )}

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

        {/* Queue section — toggle when editing */}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <p className="text-sm font-medium">Queue</p>
          {editing ? (
            <button
              onClick={() => setDraftQueue(!draftQueue)}
              className={`relative h-5 w-9 rounded-full transition-colors ${
                draftQueue ? "bg-green-500" : "bg-muted-foreground/30"
              }`}
              type="button"
            >
              <span
                className={`absolute top-0.5 size-4 rounded-full bg-white transition-transform ${
                  draftQueue ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          ) : (
            <span className="flex items-center gap-2 text-sm">
              <span
                className={`size-2 rounded-full ${
                  triggers.queue ? "bg-green-500" : "bg-muted-foreground/30"
                }`}
              />
              {triggers.queue ? "Enabled" : "Disabled"}
            </span>
          )}
        </div>

        {editing && (
          <>
            {error && (
              <div className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">{error}</div>
            )}

            {/* Show redeploy warning inline when queue value changes */}
            {draftQueue !== triggers.queue && (
              <div className="flex items-start gap-2 rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-1.5 text-xs text-yellow-200/90">
                <span>⚠</span>
                <span>Queue toggle requires redeploy. Cron changes apply immediately.</span>
              </div>
            )}

            <div className="flex items-center gap-2 pt-2">
              <Button
                size="sm"
                onClick={() => updateMutation.mutate({ cron: draftCron, queue: draftQueue })}
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
            <p className="pt-1 text-xs text-muted-foreground">
              Cron changes apply immediately. Next{" "}
              <code className="rounded bg-code-bg px-1">creek deploy</code> will overwrite with values from creek.toml.
            </p>
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
