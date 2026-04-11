import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";
import { ExternalLink } from "lucide-react";

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

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
      <GitHubConnectionSection projectId={projectId} />
      <TriggersSection projectId={projectId} />
      <DangerZone projectId={projectId} />
    </div>
  );
}

interface GitHubConnection {
  id: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
  productionBranch: string;
  autoDeployEnabled: number; // SQLite boolean
  previewEnabled: number;
  createdAt: number;
}

function GitHubConnectionSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["project", projectId, "github-connection"],
    queryFn: () =>
      api<{ connection: GitHubConnection | null }>(
        `/github/connections/by-project/${projectId}`,
      ),
  });

  const disconnect = useMutation({
    mutationFn: (connectionId: string) =>
      api(`/github/connections/${connectionId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId, "github-connection"] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        GitHub Connection
      </h2>
      <div className="rounded-lg border border-border p-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data?.connection ? (
          <ConnectionDetails
            connection={data.connection}
            onDisconnect={() => disconnect.mutate(data.connection!.id)}
            disconnectPending={disconnect.isPending}
            disconnectError={(disconnect.error as Error | null)?.message}
          />
        ) : (
          <EmptyConnection />
        )}
      </div>
    </section>
  );
}

function ConnectionDetails({
  connection,
  onDisconnect,
  disconnectPending,
  disconnectError,
}: {
  connection: GitHubConnection;
  onDisconnect: () => void;
  disconnectPending: boolean;
  disconnectError?: string;
}) {
  const repoFull = `${connection.repoOwner}/${connection.repoName}`;
  const repoUrl = `https://github.com/${repoFull}`;
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <GithubIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-sm font-medium hover:underline"
          >
            {repoFull}
            <ExternalLink className="size-3" />
          </a>
          <p className="mt-1 text-xs text-muted-foreground">
            Production branch: <span className="font-mono">{connection.productionBranch}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill enabled={!!connection.autoDeployEnabled} label="Auto-deploy on push" />
        <Pill enabled={!!connection.previewEnabled} label="Preview on pull requests" />
      </div>

      {/* Two-step disconnect — click once to reveal confirm, click again to
          actually run the DELETE. Cheap guard against fat-fingered clicks. */}
      <div className="border-t border-border pt-3">
        {confirming ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Disconnect <span className="font-mono">{repoFull}</span>? Pushes to this repo
              will stop triggering deploys. This does not uninstall the Creek Deploy GitHub
              App.
            </p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={onDisconnect}
                disabled={disconnectPending}
              >
                {disconnectPending ? "Disconnecting…" : "Yes, disconnect"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Disconnect repository
          </Button>
        )}
        {disconnectError && (
          <p className="mt-2 text-xs text-destructive">{disconnectError}</p>
        )}
      </div>
    </div>
  );
}

function Pill({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
        enabled
          ? "border-green-500/30 bg-green-500/10 text-green-400"
          : "border-border text-muted-foreground"
      }`}
    >
      <span className={`size-1.5 rounded-full ${enabled ? "bg-green-500" : "bg-muted-foreground"}`} />
      {label}
    </span>
  );
}

function EmptyConnection() {
  return (
    <div className="text-sm text-muted-foreground">
      <p>This project isn't connected to a GitHub repository.</p>
      <p className="mt-1 text-xs">
        Connect one to enable auto-deploy on push and preview deployments on pull requests.
      </p>
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
