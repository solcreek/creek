/**
 * Team-level Resources panel (team Settings page).
 *
 * List / create / rename / delete team-owned resources. Attach/detach
 * lives on the project Settings page — here we show "attached projects"
 * per row as a read-only badge.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";

interface Resource {
  id: string;
  teamId: string;
  kind: string;
  name: string;
  cfResourceId: string | null;
  cfResourceType: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

interface ResourceDetail extends Resource {
  bindings: Array<{ projectId: string; projectSlug: string; bindingName: string }>;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

export function ResourcesPanel() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<"database" | "storage" | "cache" | "ai">("database");
  const [createError, setCreateError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["resources"],
    queryFn: () => api<{ resources: Resource[] }>("/resources"),
  });

  const create = useMutation({
    mutationFn: (input: { kind: string; name: string }) =>
      api("/resources", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      setShowCreate(false);
      setNewName("");
      setCreateError(null);
      qc.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (err) => setCreateError((err as Error).message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Resources</h2>
          <p className="text-xs text-muted-foreground">
            Team-owned databases, storage buckets, and caches. Attach to one
            or more projects from the project's Settings page.
          </p>
        </div>
        {!showCreate && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            Create
          </Button>
        )}
      </div>

      {showCreate && (
        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="flex gap-2">
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as typeof newKind)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="database">database</option>
              <option value="storage">storage</option>
              <option value="cache">cache</option>
              <option value="ai">ai</option>
            </select>
            <Input
              placeholder="name (lowercase, dash/underscore)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="flex-1"
            />
            <Button
              size="sm"
              disabled={!NAME_RE.test(newName) || create.isPending}
              onClick={() => create.mutate({ kind: newKind, name: newName })}
            >
              {create.isPending ? "Creating..." : "Create"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowCreate(false);
                setNewName("");
                setCreateError(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {createError && (
            <p className="text-xs text-destructive">{createError}</p>
          )}
          {newName && !NAME_RE.test(newName) && (
            <p className="text-xs text-amber-400">
              Name must be lowercase, start with a letter, ≤63 chars; hyphen and
              underscore OK.
            </p>
          )}
        </div>
      )}

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : !data?.resources?.length ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-xs text-muted-foreground">
            No resources yet. Create one above or via{" "}
            <code className="font-mono">creek db create &lt;name&gt;</code>.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.resources.map((r) => (
            <ResourceRow key={r.id} resource={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ResourceRow({ resource }: { resource: Resource }) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(resource.name);

  const { data: detail } = useQuery({
    queryKey: ["resource", resource.id],
    queryFn: () => api<ResourceDetail>(`/resources/${resource.id}`),
  });

  const rename = useMutation({
    mutationFn: (name: string) =>
      api(`/resources/${resource.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setRenaming(false);
      qc.invalidateQueries({ queryKey: ["resources"] });
      qc.invalidateQueries({ queryKey: ["resource", resource.id] });
    },
  });

  const del = useMutation({
    mutationFn: () => api(`/resources/${resource.id}`, { method: "DELETE" }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["resources"] }),
  });

  const attachedTo = detail?.bindings ?? [];

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="rounded border border-border bg-code-bg px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {resource.kind}
        </span>
        {renaming ? (
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-7 text-xs"
            autoFocus
          />
        ) : (
          <span className="font-mono truncate">{resource.name}</span>
        )}
        {attachedTo.length > 0 ? (
          <span className="text-muted-foreground truncate">
            → {attachedTo.map((b) => `${b.projectSlug}:${b.bindingName}`).join(", ")}
          </span>
        ) : (
          <span className="text-muted-foreground">unattached</span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {renaming ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={!NAME_RE.test(newName) || newName === resource.name}
              onClick={() => rename.mutate(newName)}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRenaming(false);
                setNewName(resource.name);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={attachedTo.length > 0 || del.isPending}
              title={
                attachedTo.length > 0
                  ? "Detach from all projects before deleting"
                  : undefined
              }
              onClick={() => {
                if (confirm(`Delete "${resource.name}"? This cannot be undone.`)) {
                  del.mutate();
                }
              }}
            >
              Delete
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
