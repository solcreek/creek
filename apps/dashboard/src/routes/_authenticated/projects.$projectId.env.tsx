import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";
import { Plus, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/projects/$projectId/env")({
  component: EnvVarsTab,
});

type EnvTarget = "all" | "production" | "preview";

interface EnvVar {
  key: string;
  value: string;
  /** Absent from a control-plane without targets: every variable is "all". */
  target?: EnvTarget;
}

const TARGET_LABELS: Record<EnvTarget, string> = {
  all: "All deploys",
  production: "Production only",
  preview: "Previews only",
};

function EnvVarsTab() {
  const { projectId } = Route.useParams();
  return <EnvVarsPanel projectId={projectId} />;
}

/** The page body, separate from the route so tests can render it. */
export function EnvVarsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newTarget, setNewTarget] = useState<EnvTarget>("all");

  const { data: envVars, isLoading } = useQuery({
    queryKey: ["env", projectId],
    queryFn: () => api<EnvVar[]>(`/projects/${projectId}/env`),
  });

  const setVar = useMutation({
    mutationFn: (vars: { key: string; value: string; target: EnvTarget }) =>
      api(`/projects/${projectId}/env`, {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["env", projectId] });
      setNewKey("");
      setNewValue("");
      setNewTarget("all");
    },
  });

  const deleteVar = useMutation({
    mutationFn: (v: { key: string; target: EnvTarget }) =>
      api(
        `/projects/${projectId}/env/${encodeURIComponent(v.key)}?target=${encodeURIComponent(v.target)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["env", projectId] });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newKey && newValue) {
      setVar.mutate({ key: newKey, value: newValue, target: newTarget });
    }
  };

  return (
    <>
      {/* Add new */}
      <form onSubmit={handleSubmit} className="mb-6 flex gap-2">
        <input
          type="text"
          placeholder="KEY"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.toUpperCase())}
          className="w-40 rounded-lg border border-input bg-background px-3 py-1.5 text-sm font-mono outline-none focus:border-ring"
        />
        <input
          type="text"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          className="flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
        />
        <select
          aria-label="Deploys that get this value"
          value={newTarget}
          onChange={(e) => setNewTarget(e.target.value as EnvTarget)}
          className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
        >
          {(Object.keys(TARGET_LABELS) as EnvTarget[]).map((t) => (
            <option key={t} value={t}>
              {TARGET_LABELS[t]}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={!newKey || !newValue || setVar.isPending}>
          <Plus className="size-4" data-icon="inline-start" />
          Add
        </Button>
      </form>
      <p className="-mt-4 mb-6 text-xs text-muted-foreground">
        Preview (branch) deploys get preview and all-deploys values; production deploys get
        production and all-deploys values. Mark secrets previews must not see as Production only.
      </p>

      {/* List */}
      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : !envVars?.length ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No environment variables set. Add one above, or use the CLI:
          </p>
          <div className="mx-auto mt-3 max-w-xs rounded-md bg-code-bg px-3 py-2 text-left font-mono text-xs">
            <span className="text-muted-foreground">$</span> npx creek env set DATABASE_URL
            "postgres://..."
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          {envVars.map((v) => (
            <div
              key={`${v.key}:${v.target ?? "all"}`}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm">{v.key}</span>
                <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                  {TARGET_LABELS[v.target ?? "all"]}
                </span>
                <span className="text-sm text-muted-foreground">{v.value}</span>
              </div>
              <button
                aria-label={`Remove ${v.key} (${TARGET_LABELS[v.target ?? "all"]})`}
                onClick={() => deleteVar.mutate({ key: v.key, target: v.target ?? "all" })}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
