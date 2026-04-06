import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";
import { Plus, Trash2 } from "lucide-react";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/env",
)({
  component: EnvVarsTab,
});

interface EnvVar {
  key: string;
  value: string;
}

function EnvVarsTab() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const { data: envVars, isLoading } = useQuery({
    queryKey: ["env", projectId],
    queryFn: () => api<EnvVar[]>(`/projects/${projectId}/env`),
  });

  const setVar = useMutation({
    mutationFn: (vars: { key: string; value: string }) =>
      api(`/projects/${projectId}/env`, {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["env", projectId] });
      setNewKey("");
      setNewValue("");
    },
  });

  const deleteVar = useMutation({
    mutationFn: (key: string) =>
      api(`/projects/${projectId}/env/${key}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["env", projectId] });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newKey && newValue) {
      setVar.mutate({ key: newKey, value: newValue });
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
        <Button type="submit" size="sm" disabled={!newKey || !newValue || setVar.isPending}>
          <Plus className="size-4" data-icon="inline-start" />
          Add
        </Button>
      </form>

      {/* List */}
      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : !envVars?.length ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No environment variables set. Add one above, or use the CLI:
          </p>
          <div className="mx-auto mt-3 max-w-xs rounded-md bg-code-bg px-3 py-2 text-left font-mono text-xs">
            <span className="text-muted-foreground">$</span> npx creek env set DATABASE_URL "postgres://..."
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          {envVars.map((v) => (
            <div
              key={v.key}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm">{v.key}</span>
                <span className="text-sm text-muted-foreground">{v.value}</span>
              </div>
              <button
                onClick={() => deleteVar.mutate(v.key)}
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
