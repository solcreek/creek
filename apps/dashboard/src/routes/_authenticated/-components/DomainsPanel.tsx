import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2, Copy, Globe, Info, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@solcreek/ui/components/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@solcreek/ui/components/alert-dialog";
import { Badge } from "@solcreek/ui/components/badge";
import { Button } from "@solcreek/ui/components/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@solcreek/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@solcreek/ui/components/empty";
import { Field, FieldLabel } from "@solcreek/ui/components/field";
import { Input } from "@solcreek/ui/components/input";
import { Spinner } from "@solcreek/ui/components/spinner";
import { Switch } from "@solcreek/ui/components/switch";
import { ConnectionError } from "@/components/connection-error";
import { api, ApiError } from "@/lib/api";

// Shapes of the control-plane routes under /projects/:project/domains
// (packages/control-plane/src/modules/domains/routes.ts). The CLI's
// `creek domains` drives the same routes.

/** A row of GET /projects/:project/domains. */
export interface CustomDomain {
  id: string;
  projectId: string;
  hostname: string;
  /** pending → active once the edge confirms DNS; failed when the edge dropped it. */
  status: "pending" | "provisioning" | "active" | "failed" | (string & {});
  /** 1 on the project's primary domain. Absent from an API without primary domains. */
  isPrimary?: number | boolean;
  createdAt: number;
}

interface DnsRecord {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  /** Why to set it, in words a person can act on (apex wording included). */
  purpose: string;
}

interface DnsInstruction {
  /** The routing record alone; predates `records`. */
  cname: { name: string; target: string };
  apex?: boolean;
  /** Every record to set, routing first. */
  records?: DnsRecord[];
}

/** GET /projects/:project/domains/:id — refreshes status from the edge. */
interface DomainDetail extends CustomDomain {
  dns: DnsInstruction;
}

interface AddDomainResult {
  domain: CustomDomain;
  verification: DnsInstruction | null;
  idempotent?: boolean;
}

/** POST …/:id/activate. Only `active` when the edge confirms (or, with no edge, `manual`). */
interface ActivateResult {
  ok: boolean;
  status?: "active" | "pending_dns" | "pending_edge";
  message?: string;
  manual?: boolean;
}

/** The project row (GET /projects/:project): only the redirect setting is read here. */
interface ProjectRedirectSetting {
  /** 0/1 from the database; absent before primary domains existed. */
  redirectToPrimaryDomain?: number | boolean | null;
}

const isPrimary = (d: CustomDomain) => Boolean(d.isPrimary);

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You don't have permission to manage domains on this team.";
    return err.message || err.code;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The routing record plus any ownership record; falls back to `cname` for an older API. */
function recordsOf(dns: DnsInstruction): DnsRecord[] {
  if (dns.records?.length) return dns.records;
  return [
    {
      type: "CNAME",
      name: dns.cname.name,
      value: dns.cname.target,
      purpose: "Routes the domain to Creek.",
    },
  ];
}

/**
 * The domain the control plane promotes when the primary one is removed:
 * the oldest active domain, else the oldest of any status
 * (domains/primary.ts promotePrimaryIfNone).
 */
function successorOf(domains: CustomDomain[], removing: CustomDomain): CustomDomain | undefined {
  return domains
    .filter((d) => d.id !== removing.id)
    .sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    )[0];
}

/**
 * A project's custom domains: add, DNS records, activate, primary, redirect
 * and remove — what `creek domains` does from the CLI.
 */
export function DomainsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const listKey = ["domains", projectId];
  const [hostname, setHostname] = useState("");
  // Domains whose DNS records are shown; a domain just added opens its own.
  const [openDns, setOpenDns] = useState<Record<string, boolean>>({});

  const domains = useQuery({
    queryKey: listKey,
    queryFn: () => api<CustomDomain[]>(`/projects/${projectId}/domains`),
  });

  const add = useMutation({
    mutationFn: (name: string) =>
      api<AddDomainResult>(`/projects/${projectId}/domains`, {
        method: "POST",
        body: JSON.stringify({ hostname: name }),
      }),
    onSuccess: (result) => {
      setHostname("");
      if (result.domain.status !== "active") {
        setOpenDns((prev) => ({ ...prev, [result.domain.id]: true }));
      }
      void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = hostname.trim();
    if (name) add.mutate(name);
  };

  const list = domains.data ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Custom domains</CardTitle>
          <CardDescription>
            Serve this project on a domain you own. Add it here, point its DNS at Creek, and the
            certificate is issued once the record resolves.
          </CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field className="min-w-0 flex-1">
              <FieldLabel>Domain</FieldLabel>
              <Input
                value={hostname}
                onChange={(e) => {
                  setHostname(e.target.value);
                  if (add.isError || add.data?.idempotent) add.reset();
                }}
                placeholder="app.example.com"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={add.isError || undefined}
              />
            </Field>
            <Button type="submit" disabled={!hostname.trim()} loading={add.isPending}>
              <Plus data-icon="inline-start" />
              Add domain
            </Button>
          </form>
          {add.isError && (
            <Alert variant="error">
              <AlertTriangle />
              <AlertDescription className="text-foreground">
                Could not add the domain: {errorMessage(add.error)}
              </AlertDescription>
            </Alert>
          )}
          {add.data?.idempotent && (
            <Alert variant="info" role="status">
              <Info />
              <AlertDescription className="text-foreground">
                {add.data.domain.hostname} is already a domain of this project.
              </AlertDescription>
            </Alert>
          )}
        </CardPanel>

        <div className="border-t">
          {domains.isLoading ? (
            <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading domains…
            </p>
          ) : domains.error ? (
            <div className="p-4 sm:p-6">
              <ConnectionError error={domains.error} onRetry={() => void domains.refetch()} />
            </div>
          ) : list.length === 0 ? (
            <Empty className="py-10 md:py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Globe />
                </EmptyMedia>
                <EmptyTitle className="text-base">No custom domains</EmptyTitle>
                <EmptyDescription>
                  The project is served on its default hostname only. Add a domain above, or run{" "}
                  <code className="rounded bg-code-bg px-1 font-mono text-xs">
                    creek domains add app.example.com
                  </code>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y" aria-label="Custom domains">
              {list.map((domain) => (
                <DomainRow
                  key={domain.id}
                  projectId={projectId}
                  domain={domain}
                  domains={list}
                  dnsOpen={Boolean(openDns[domain.id])}
                  onToggleDns={() =>
                    setOpenDns((prev) => ({ ...prev, [domain.id]: !prev[domain.id] }))
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </Card>

      <RedirectSetting projectId={projectId} domains={domains.data} />
    </div>
  );
}

function StatusBadge({ status }: { status: CustomDomain["status"] }) {
  switch (status) {
    case "active":
      return <Badge variant="success">Active</Badge>;
    case "pending":
      return <Badge variant="warning">Pending</Badge>;
    case "provisioning":
      return <Badge variant="info">Provisioning</Badge>;
    case "failed":
      return <Badge variant="error">Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function statusHint(domain: CustomDomain): string | null {
  switch (domain.status) {
    case "pending":
      return "Waiting for DNS. Set the DNS records, then activate.";
    case "provisioning":
      return "The edge is setting this domain up.";
    case "failed":
      return "The edge no longer has this hostname. Remove it and add it again.";
    default:
      return null;
  }
}

function DomainRow({
  projectId,
  domain,
  domains,
  dnsOpen,
  onToggleDns,
}: {
  projectId: string;
  domain: CustomDomain;
  domains: CustomDomain[];
  dnsOpen: boolean;
  onToggleDns: () => void;
}) {
  const queryClient = useQueryClient();
  const listKey = ["domains", projectId];
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const active = domain.status === "active";
  const primary = isPrimary(domain);
  const hint = statusHint(domain);

  const activate = useMutation({
    mutationFn: () =>
      api<ActivateResult>(`/projects/${projectId}/domains/${domain.id}/activate`, {
        method: "POST",
      }),
    // The list, and this domain's own records (the edge may have answered);
    // not every open domain's, each of which asks the edge again.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: [...listKey, domain.id], exact: true });
    },
  });

  const makePrimary = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/domains/${domain.id}/primary`, { method: "POST" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: listKey, exact: true }),
  });

  const remove = useMutation({
    mutationFn: () => api(`/projects/${projectId}/domains/${domain.id}`, { method: "DELETE" }),
    onSuccess: () => setConfirmingRemove(false),
    // Also on failure: a domain removed elsewhere meanwhile drops out of the list.
    // Only the list: refetching this row's open DNS records would ask for a
    // domain that no longer exists.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: listKey, exact: true }),
  });

  const successor = primary ? successorOf(domains, domain) : undefined;

  return (
    <li className="space-y-3 p-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            {active ? (
              <a
                href={`https://${domain.hostname}`}
                target="_blank"
                rel="noreferrer"
                className="font-medium [overflow-wrap:anywhere] hover:underline"
              >
                {domain.hostname}
              </a>
            ) : (
              <span className="font-medium [overflow-wrap:anywhere]">{domain.hostname}</span>
            )}
            <StatusBadge status={domain.status} />
            {primary && <Badge variant="info">Primary</Badge>}
          </div>
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!active && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => activate.mutate()}
              loading={activate.isPending}
            >
              Activate
            </Button>
          )}
          {!primary && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => makePrimary.mutate()}
              loading={makePrimary.isPending}
            >
              Make primary
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-expanded={dnsOpen} onClick={onToggleDns}>
            {dnsOpen ? "Hide DNS" : "DNS records"}
          </Button>
          <AlertDialog
            open={confirmingRemove}
            onOpenChange={(open) => {
              setConfirmingRemove(open);
              if (!open) remove.reset();
            }}
          >
            <AlertDialogTrigger
              render={
                <Button size="icon-sm" variant="ghost" aria-label={`Remove ${domain.hostname}`} />
              }
            >
              <Trash2 />
            </AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle className="text-lg [overflow-wrap:anywhere]">
                  Remove {domain.hostname}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Creek stops serving this project on {domain.hostname} and releases it at the edge.{" "}
                  {primary &&
                    (successor
                      ? `It is the primary domain: ${successor.hostname} becomes the primary one.`
                      : "It is the only domain: the default hostname serves the site itself again.")}
                </AlertDialogDescription>
                {remove.isError && (
                  <Alert variant="error" className="mt-2 text-left">
                    <AlertTriangle />
                    <AlertDescription className="text-foreground">
                      Could not remove the domain: {errorMessage(remove.error)}
                    </AlertDescription>
                  </Alert>
                )}
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
                <Button
                  variant="destructive"
                  onClick={() => remove.mutate()}
                  loading={remove.isPending}
                >
                  Remove domain
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      </div>

      {activate.isSuccess && <ActivateNotice result={activate.data} />}
      {activate.isError && (
        <Alert variant="error">
          <AlertTriangle />
          <AlertDescription className="text-foreground">
            Could not activate: {errorMessage(activate.error)}
          </AlertDescription>
        </Alert>
      )}
      {makePrimary.isError && (
        <Alert variant="error">
          <AlertTriangle />
          <AlertDescription className="text-foreground">
            Could not make it primary: {errorMessage(makePrimary.error)}
          </AlertDescription>
        </Alert>
      )}

      {dnsOpen && <DnsRecords projectId={projectId} domain={domain} />}
    </li>
  );
}

/** Activate is honest: only `active` when the edge confirms the hostname. */
function ActivateNotice({ result }: { result: ActivateResult }) {
  if (result.ok) {
    return (
      <Alert variant="success" role="status">
        <CheckCircle2 />
        <AlertDescription className="text-foreground">
          {result.manual
            ? "Activated as a manual override: this server has no edge to verify DNS against."
            : "Active. DNS is verified and the certificate is in place."}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="warning" role="status">
      <AlertTriangle />
      <AlertDescription className="text-foreground">
        {result.message ?? "Not verified yet. Set the DNS records, then try again."}
      </AlertDescription>
    </Alert>
  );
}

function DnsRecords({ projectId, domain }: { projectId: string; domain: CustomDomain }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["domains", projectId, domain.id],
    queryFn: () => api<DomainDetail>(`/projects/${projectId}/domains/${domain.id}`),
  });

  // Reading one domain asks the edge for its status: when that moved on,
  // the list behind this row is stale.
  const fresh = detail.data?.status;
  useEffect(() => {
    if (fresh && fresh !== domain.status) {
      void queryClient.invalidateQueries({ queryKey: ["domains", projectId], exact: true });
    }
  }, [fresh, domain.status, projectId, queryClient]);

  if (detail.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Loading DNS records…
      </p>
    );
  }
  if (detail.error) {
    return (
      <Alert variant="error">
        <AlertTriangle />
        <AlertDescription className="text-foreground">
          Could not load the DNS records: {errorMessage(detail.error)}
        </AlertDescription>
      </Alert>
    );
  }
  if (!detail.data) return null;

  return (
    <div className="space-y-3 rounded-xl border bg-muted/40 p-3 sm:p-4">
      <p className="text-xs text-muted-foreground">
        {domain.status === "active"
          ? "DNS records for this domain:"
          : "Create these records at your DNS provider:"}
      </p>
      {recordsOf(detail.data.dns).map((record) => (
        <div key={`${record.type}:${record.name}`} className="space-y-2">
          <div className="flex items-start gap-2">
            <Badge variant="outline" className="mt-0.5 font-mono">
              {record.type}
            </Badge>
            <p className="text-xs text-muted-foreground">{record.purpose}</p>
          </div>
          <dl className="grid gap-2 sm:grid-cols-2">
            <CopyField label="Name" value={record.name} />
            <CopyField label={record.type === "CNAME" ? "Target" : "Value"} value={record.value} />
          </dl>
        </div>
      ))}
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex items-center gap-1 rounded-lg border bg-background py-0.5 pr-0.5 pl-2.5">
        <code className="min-w-0 flex-1 font-mono text-xs select-all [overflow-wrap:anywhere]">
          {value}
        </code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()} ${value}`} />
      </dd>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={label}
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            // Denied clipboard: the value stays selectable to copy by hand.
            () => {},
          );
        }}
      >
        {copied ? <Check className="text-success-foreground" /> : <Copy />}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

/**
 * Whether the default {project}-{team} hostname redirects to the primary
 * domain. The dispatch worker answers it with a 308 once the primary domain
 * is active; with the redirect off it serves the site, marked noindex.
 */
function RedirectSetting({
  projectId,
  domains,
}: {
  projectId: string;
  domains: CustomDomain[] | undefined;
}) {
  const queryClient = useQueryClient();
  const labelId = useId();
  const projectKey = ["project", projectId];

  const project = useQuery({
    queryKey: projectKey,
    queryFn: () => api<ProjectRedirectSetting>(`/projects/${projectId}`),
  });

  const update = useMutation({
    mutationFn: (redirectToPrimary: boolean) =>
      api<{ ok: boolean; redirectToPrimary: boolean }>(`/projects/${projectId}/domains`, {
        method: "PATCH",
        body: JSON.stringify({ redirectToPrimary }),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData<ProjectRedirectSetting>(projectKey, (prev) =>
        prev ? { ...prev, redirectToPrimaryDomain: result.redirectToPrimary ? 1 : 0 } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: projectKey, exact: true });
    },
  });

  const setting = project.data?.redirectToPrimaryDomain;
  // An API from before primary domains has no setting to show.
  if (project.isSuccess && (setting === undefined || setting === null)) return null;

  const on = Boolean(setting);
  const primary = domains?.find(isPrimary);

  let state: string | null = null;
  if (project.isSuccess && domains) {
    if (on) {
      state = !primary
        ? "The project has no domain yet: the redirect starts once one is added and active."
        : primary.status === "active"
          ? `The default hostname redirects to ${primary.hostname}.`
          : `${primary.hostname} is ${primary.status}: the redirect starts once it is active.`;
    } else {
      state =
        primary?.status === "active"
          ? `The default hostname serves the site itself, marked noindex so search engines list ${primary.hostname} instead.`
          : "The default hostname serves the site itself.";
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Redirect to the primary domain</CardTitle>
        <CardDescription>
          The primary domain is the project's canonical address. With the redirect on, the project's
          default hostname answers with a permanent redirect (308) to it, keeping the path and
          query.
        </CardDescription>
      </CardHeader>
      <CardPanel className="space-y-3">
        {project.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading…
          </p>
        ) : project.error ? (
          <Alert variant="error">
            <AlertTriangle />
            <AlertDescription className="text-foreground">
              Could not load the redirect setting: {errorMessage(project.error)}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <span id={labelId} className="text-sm font-medium">
                Redirect the default hostname
              </span>
              <Switch
                aria-labelledby={labelId}
                checked={on}
                disabled={update.isPending}
                onCheckedChange={(checked) => update.mutate(checked)}
              />
            </div>
            {state && <p className="text-sm text-muted-foreground">{state}</p>}
          </>
        )}
        {update.isError && (
          <Alert variant="error">
            <AlertTriangle />
            <AlertDescription className="text-foreground">
              Could not change the redirect: {errorMessage(update.error)}
            </AlertDescription>
          </Alert>
        )}
      </CardPanel>
    </Card>
  );
}
