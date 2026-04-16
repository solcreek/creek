import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";

interface ResourceDetail {
  id: string;
  teamId: string;
  kind: string;
  name: string;
  cfResourceId: string | null;
  cfResourceType: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  bindings: Array<{ projectId: string; projectSlug: string; bindingName: string }>;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;

const KIND_LABELS: Record<string, string> = {
  database: "Database",
  storage: "Storage",
  cache: "Cache",
  ai: "AI",
};

const CF_TYPE_LABELS: Record<string, string> = {
  d1: "D1 SQL Database",
  r2: "R2 Object Storage",
  kv: "KV Namespace",
};

export const Route = createFileRoute(
  "/_authenticated/resources/$resourceId",
)({
  component: ResourceDetailPage,
});

function ResourceDetailPage() {
  const { resourceId } = Route.useParams();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["resource", resourceId],
    queryFn: () => api<ResourceDetail>(`/resources/${resourceId}`),
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Resource not found.</p>
        <Link to="/resources/database" className="mt-2 text-sm text-muted-foreground hover:underline">
          Back to Resources
        </Link>
      </div>
    );
  }

  const kindPath = data.kind as "database" | "storage" | "cache" | "ai";

  return (
    <div className="p-6">
      <div className="mb-1">
        <Link
          to={`/resources/${kindPath}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; {KIND_LABELS[data.kind] ?? data.kind}
        </Link>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-xl font-semibold font-mono">{data.name}</h1>
        <span className="rounded border border-border bg-code-bg px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {data.kind}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] ${
          data.status === "active"
            ? "bg-green-500/10 text-green-400 border border-green-500/30"
            : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/30"
        }`}>
          {data.status}
        </span>
      </div>

      <div className="max-w-2xl space-y-8">
        <MetadataSection resource={data} />
        <BindingsSection resource={data} />
        <RenameSection resource={data} />
        <DeleteSection resource={data} />
      </div>
    </div>
  );
}

function MetadataSection({ resource }: { resource: ResourceDetail }) {
  const rows = [
    { label: "ID", value: resource.id, mono: true },
    { label: "Kind", value: KIND_LABELS[resource.kind] ?? resource.kind },
    {
      label: "Cloudflare Type",
      value: resource.cfResourceType
        ? CF_TYPE_LABELS[resource.cfResourceType] ?? resource.cfResourceType
        : "Not provisioned",
    },
    {
      label: "CF Resource ID",
      value: resource.cfResourceId ?? "—",
      mono: true,
    },
    {
      label: "Created",
      value: new Date(resource.createdAt).toLocaleString(),
    },
    {
      label: "Updated",
      value: new Date(resource.updatedAt).toLocaleString(),
    },
  ];

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Details
      </h2>
      <div className="rounded-lg border border-border divide-y divide-border">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-xs text-muted-foreground">{row.label}</span>
            <span className={`text-xs ${row.mono ? "font-mono" : ""} text-foreground`}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function BindingsSection({ resource }: { resource: ResourceDetail }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Attached Projects
      </h2>
      {resource.bindings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-xs text-muted-foreground">
            Not attached to any project. Go to a project's Settings to attach it.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border">
          {resource.bindings.map((b) => (
            <div key={`${b.projectId}-${b.bindingName}`} className="flex items-center justify-between px-4 py-2.5">
              <Link
                to={`/projects/${b.projectSlug}/settings`}
                className="text-sm font-mono hover:underline"
              >
                {b.projectSlug}
              </Link>
              <span className="text-xs text-muted-foreground">
                env.{b.bindingName}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RenameSection({ resource }: { resource: ResourceDetail }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState(resource.name);

  const rename = useMutation({
    mutationFn: (name: string) =>
      api(`/resources/${resource.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["resource", resource.id] });
      qc.invalidateQueries({ queryKey: ["resources"] });
    },
  });

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Rename
      </h2>
      <div className="rounded-lg border border-border p-4">
        {editing ? (
          <div className="space-y-3">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="font-mono text-sm"
              autoFocus
            />
            {newName && !NAME_RE.test(newName) && (
              <p className="text-xs text-amber-400">
                Lowercase, start with letter, &le;63 chars. Hyphen/underscore OK.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!NAME_RE.test(newName) || newName === resource.name || rename.isPending}
                onClick={() => rename.mutate(newName)}
              >
                {rename.isPending ? "Renaming..." : "Save"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setNewName(resource.name); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Rename this resource. All existing bindings continue to work — they reference the stable ID, not the name.
            </p>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Rename
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function DeleteSection({ resource }: { resource: ResourceDetail }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const hasBindings = resource.bindings.length > 0;

  const del = useMutation({
    mutationFn: () => api(`/resources/${resource.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resources"] });
      window.location.href = `/resources/${resource.kind}`;
    },
  });

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-destructive">
        Danger Zone
      </h2>
      <div className="rounded-lg border border-destructive/30 p-4">
        {hasBindings ? (
          <p className="text-sm text-muted-foreground">
            This resource is attached to {resource.bindings.length} project(s). Detach from all projects before deleting.
          </p>
        ) : confirming ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Delete <span className="font-mono font-medium text-foreground">{resource.name}</span>? The backing Cloudflare resource will be scheduled for cleanup. This cannot be undone.
            </p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={del.isPending}
                onClick={() => del.mutate()}
              >
                {del.isPending ? "Deleting..." : "Yes, delete"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Permanently delete this resource and its backing Cloudflare infrastructure.
            </p>
            <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
