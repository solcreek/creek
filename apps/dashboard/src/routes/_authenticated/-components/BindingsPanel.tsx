/**
 * Per-project Bindings panel (project Settings page).
 *
 * Shows which team resources are attached to this project under which
 * ENV var names. Allows attach via dropdown-of-existing-resources and
 * detach inline.
 */

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";

interface Resource {
  id: string;
  kind: string;
  name: string;
  status: string;
}

interface Binding {
  bindingName: string;
  resourceId: string;
  kind: string;
  name: string;
  status: string;
  createdAt: number;
}

const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]{0,62}$/;

export function BindingsPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [selectedResourceId, setSelectedResourceId] = useState<string>("");
  const [bindingName, setBindingName] = useState("DB");
  const [attachError, setAttachError] = useState<string | null>(null);

  const { data: resources } = useQuery({
    queryKey: ["resources"],
    queryFn: () => api<{ resources: Resource[] }>("/resources"),
  });

  const { data: bindings, isLoading } = useQuery({
    queryKey: ["bindings", projectId],
    queryFn: () => api<{ bindings: Binding[] }>(`/projects/${projectId}/bindings`),
  });

  const attach = useMutation({
    mutationFn: (input: { resourceId: string; bindingName: string }) =>
      api(`/projects/${projectId}/bindings`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      setAdding(false);
      setSelectedResourceId("");
      setBindingName("DB");
      setAttachError(null);
      qc.invalidateQueries({ queryKey: ["bindings", projectId] });
    },
    onError: (err) => setAttachError((err as Error).message),
  });

  const detach = useMutation({
    mutationFn: (name: string) =>
      api(`/projects/${projectId}/bindings/${name}`, { method: "DELETE" }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["bindings", projectId] }),
  });

  // Don't show resources that are already bound under any name — users
  // occasionally want the same resource under two names, but it's rare.
  // Keeping the UI simple; attach by CLI is the escape hatch.
  const availableResources = useMemo(() => {
    const bound = new Set(bindings?.bindings.map((b) => b.resourceId) ?? []);
    return (resources?.resources ?? []).filter(
      (r) => r.status === "active" && !bound.has(r.id),
    );
  }, [resources, bindings]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Resource bindings</h2>
          <p className="text-xs text-muted-foreground">
            Which team resources are available in this project's runtime and
            under which ENV var name. Your code reads{" "}
            <code className="font-mono">env.DB</code> etc. — no wrangler.toml
            hand-editing needed.
          </p>
        </div>
        {!adding && availableResources.length > 0 && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Attach
          </Button>
        )}
      </div>

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedResourceId}
              onChange={(e) => setSelectedResourceId(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="">Choose resource…</option>
              {availableResources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.kind}: {r.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">as env.</span>
            <Input
              value={bindingName}
              onChange={(e) => setBindingName(e.target.value.toUpperCase())}
              className="h-8 w-32 text-sm font-mono"
            />
            <Button
              size="sm"
              disabled={
                !selectedResourceId ||
                !BINDING_NAME_RE.test(bindingName) ||
                attach.isPending
              }
              onClick={() =>
                attach.mutate({ resourceId: selectedResourceId, bindingName })
              }
            >
              {attach.isPending ? "Attaching..." : "Attach"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false);
                setAttachError(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {attachError && (
            <p className="text-xs text-destructive">{attachError}</p>
          )}
          {bindingName && !BINDING_NAME_RE.test(bindingName) && (
            <p className="text-xs text-amber-400">
              Binding name must be uppercase, start with a letter, ≤63 chars.
            </p>
          )}
        </div>
      )}

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !bindings?.bindings?.length ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-xs text-muted-foreground">
            No resources attached. Create one in team Settings → Resources, then
            attach it here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {bindings.bindings.map((b) => (
            <li
              key={b.bindingName}
              className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-foreground">env.{b.bindingName}</span>
                <span className="text-muted-foreground">→</span>
                <span className="rounded border border-border bg-code-bg px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {b.kind}
                </span>
                <span className="font-mono truncate">{b.name}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (confirm(`Detach env.${b.bindingName}?`)) {
                    detach.mutate(b.bindingName);
                  }
                }}
              >
                Detach
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
