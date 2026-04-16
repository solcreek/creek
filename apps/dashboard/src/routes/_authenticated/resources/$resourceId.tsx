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
        <MetricsSection resourceId={resourceId} kind={data.kind} />
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

function MetricsSection({ resourceId, kind }: { resourceId: string; kind: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["resource-metrics", resourceId],
    queryFn: () => api<Record<string, unknown>>(`/resources/${resourceId}/metrics`),
    refetchInterval: 60_000, // refresh every minute
  });

  if (isLoading) {
    return (
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Usage
        </h2>
        <p className="text-xs text-muted-foreground">Loading metrics...</p>
      </section>
    );
  }

  if (error || !data) return null;

  const metrics: { label: string; value: string }[] = [];

  if (kind === "database") {
    if (data.size != null) {
      const sizeMb = Number(data.size) / (1024 * 1024);
      metrics.push({ label: "Database Size", value: sizeMb < 1 ? `${(Number(data.size) / 1024).toFixed(1)} KB` : `${sizeMb.toFixed(2)} MB` });
    }
    if (data.tables != null) metrics.push({ label: "Tables", value: String(data.tables) });
    if (data.version != null) metrics.push({ label: "Version", value: String(data.version) });
  } else if (kind === "storage") {
    if (data.objects != null) metrics.push({ label: "Objects", value: String(data.objects) });
  } else if (kind === "cache") {
    if (data.keys != null) metrics.push({ label: "Keys", value: String(data.keys) });
  }

  if (metrics.length === 0) return null;

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Usage
      </h2>
      <div className="grid grid-cols-3 gap-3">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{m.label}</p>
            <p className="mt-1 text-lg font-semibold font-mono">{m.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function BindingsSection({ resource }: { resource: ResourceDetail }) {
  const qc = useQueryClient();
  const [attaching, setAttaching] = useState(false);
  const [selectedProject, setSelectedProject] = useState("");
  const [bindingName, setBindingName] = useState(
    resource.kind === "database" ? "DB"
    : resource.kind === "storage" ? "STORAGE"
    : resource.kind === "cache" ? "KV"
    : resource.kind === "ai" ? "AI"
    : "BINDING",
  );
  const [attachError, setAttachError] = useState<string | null>(null);

  const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]{0,62}$/;

  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Array<{ id: string; slug: string }>>("/projects"),
    enabled: attaching,
  });

  // Filter out projects that already have this resource attached
  const boundSlugs = new Set(resource.bindings.map((b) => b.projectSlug));
  const availableProjects = (projects ?? []).filter((p) => !boundSlugs.has(p.slug));

  const attach = useMutation({
    mutationFn: (input: { projectSlug: string; resourceId: string; bindingName: string }) =>
      api(`/projects/${input.projectSlug}/bindings`, {
        method: "POST",
        body: JSON.stringify({ resourceId: input.resourceId, bindingName: input.bindingName }),
      }),
    onSuccess: () => {
      setAttaching(false);
      setSelectedProject("");
      setAttachError(null);
      qc.invalidateQueries({ queryKey: ["resource", resource.id] });
    },
    onError: (err) => setAttachError((err as Error).message),
  });

  const detach = useMutation({
    mutationFn: (input: { projectSlug: string; bindingName: string }) =>
      api(`/projects/${input.projectSlug}/bindings/${input.bindingName}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource", resource.id] });
    },
  });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Attached Projects
        </h2>
        {!attaching && (
          <Button size="sm" variant="ghost" onClick={() => setAttaching(true)}>
            Attach
          </Button>
        )}
      </div>

      {attaching && (
        <div className="mb-3 rounded-lg border border-border p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="">Choose project...</option>
              {availableProjects.map((p) => (
                <option key={p.id} value={p.slug}>{p.slug}</option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">as env.</span>
            <Input
              value={bindingName}
              onChange={(e) => setBindingName(e.target.value.toUpperCase())}
              className="h-8 w-28 text-sm font-mono"
            />
            <Button
              size="sm"
              disabled={!selectedProject || !BINDING_NAME_RE.test(bindingName) || attach.isPending}
              onClick={() => attach.mutate({
                projectSlug: selectedProject,
                resourceId: resource.id,
                bindingName,
              })}
            >
              {attach.isPending ? "Attaching..." : "Attach"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setAttaching(false); setAttachError(null); }}>
              Cancel
            </Button>
          </div>
          {attachError && <p className="text-xs text-destructive">{attachError}</p>}
          {bindingName && !BINDING_NAME_RE.test(bindingName) && (
            <p className="text-xs text-amber-400">Uppercase, start with letter, &le;63 chars.</p>
          )}
        </div>
      )}

      {resource.bindings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-xs text-muted-foreground">
            Not attached to any project. Click Attach above or use{" "}
            <code className="font-mono">creek db attach {resource.name} --to &lt;project&gt;</code>.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border">
          {resource.bindings.map((b) => (
            <div key={`${b.projectId}-${b.bindingName}`} className="flex items-center justify-between px-4 py-2.5">
              <div className="flex items-center gap-2">
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
              <Button
                variant="ghost"
                size="sm"
                disabled={detach.isPending}
                onClick={() => {
                  if (confirm(`Detach env.${b.bindingName} from ${b.projectSlug}?`)) {
                    detach.mutate({ projectSlug: b.projectSlug, bindingName: b.bindingName });
                  }
                }}
              >
                Detach
              </Button>
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
