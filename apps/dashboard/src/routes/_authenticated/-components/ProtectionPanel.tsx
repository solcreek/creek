import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@solcreek/ui/components/button";
import { Textarea } from "@solcreek/ui/components/textarea";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { CloudflareStatus } from "./CloudflarePanel";

/** Who a Creek-managed setup lets in, as GET /projects/:id/access reports it. */
export interface ManagedAccessView {
  accountId: string;
  emails: string[];
  emailDomains: string[];
  teamMembers: boolean;
  /** The team's members today, when teamMembers is on. */
  memberEmails: string[];
  /** The members Cloudflare lets in until the next sync; null when unknown or teamMembers is off. */
  appliedMemberEmails: string[] | null;
  /** Whether Cloudflare still has the domains and members of the last sync. */
  outOfSync: { hostnames: boolean; members: boolean };
}

/** GET /projects/:id/access. */
export type AccessStatus =
  | { protected: false; hostnames: string[] }
  | {
      protected: true;
      teamDomain: string;
      aud: string;
      bypassPaths: string[];
      hostnames: string[];
      managed: null;
    }
  | {
      protected: true;
      teamDomain: string;
      aud: string;
      bypassPaths: string[];
      hostnames: string[];
      managed: ManagedAccessView;
      /** Listed email domains mail cannot reach: no such domain, or a null MX. */
      noMailDomains: string[];
      /** Listed email domains with no MX record: mail most likely fails. */
      noMxDomains: string[];
    };

interface ManagedBody {
  accountId?: string;
  emails: string[];
  emailDomains: string[];
  teamMembers: boolean;
  bypassPaths: string[];
}

interface RemoveResult {
  ok: true;
  protected: false;
  cloudflareCleanup?: { ok: false; message: string; accountId: string; appIds: string[] };
}

/** Lines or commas, trimmed, empties dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You don't have permission to change this project's protection.";
    return err.message || err.code;
  }
  return err instanceof Error ? err.message : String(err);
}

/** A Cloudflare dashboard link some refusals carry (Zero Trust not set up yet, no login method). */
function setupUrlOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const url = err.body.setupUrl;
  return typeof url === "string" && url.startsWith("https://dash.cloudflare.com/") ? url : null;
}

/**
 * Cloudflare Access protection for a project: Creek makes the Access
 * applications in the team's connected Cloudflare account and keeps them in
 * line with who may get in.
 */
export function ProtectionPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const accessKey = ["project", projectId, "access"];
  const [editing, setEditing] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);

  const access = useQuery({
    queryKey: accessKey,
    queryFn: () => api<AccessStatus>(`/projects/${projectId}/access`),
  });
  const cloudflare = useQuery({
    queryKey: ["integrations", "cloudflare", "active-team"],
    queryFn: () => api<CloudflareStatus>("/integrations/cloudflare"),
  });

  const save = useMutation({
    mutationFn: (body: ManagedBody) =>
      api<unknown>(`/projects/${projectId}/access/managed`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: accessKey });
    },
  });

  const remove = useMutation({
    mutationFn: () => api<RemoveResult>(`/projects/${projectId}/access`, { method: "DELETE" }),
    onSettled: () => {
      setConfirmingOff(false);
      void queryClient.invalidateQueries({ queryKey: accessKey });
    },
  });

  const status = access.data;
  const cf = cloudflare.data;
  const connected = cf?.connected === true && !cf.needsReauth;
  const accounts = cf?.connected ? cf.accounts : [];

  let content: React.ReactNode;
  if (access.isLoading) {
    content = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );
  } else if (access.error || !status) {
    content = (
      <p className="text-sm text-destructive">
        Could not load protection: {errorMessage(access.error)}
      </p>
    );
  } else if (editing) {
    content = (
      <ProtectionForm
        initial={status.protected && status.managed ? status : null}
        bypassPaths={status.protected ? status.bypassPaths : []}
        accounts={accounts}
        pending={save.isPending}
        error={save.error}
        onSubmit={(body) => save.mutate(body)}
        onCancel={() => {
          setEditing(false);
          save.reset();
        }}
      />
    );
  } else if (!status.protected) {
    content = (
      <Unprotected
        hostnames={status.hostnames}
        cloudflare={cf}
        cloudflareLoading={cloudflare.isLoading}
        onStart={() => setEditing(true)}
      />
    );
  } else {
    content = (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-sm">
          <ShieldCheck className="size-4 text-success-foreground" />
          Protected by Cloudflare Access
          <span className="font-mono text-xs text-muted-foreground">{status.teamDomain}</span>
        </p>

        {status.managed ? (
          <ManagedSummary
            status={status}
            syncing={save.isPending}
            syncError={save.error}
            onSync={() =>
              save.mutate({
                accountId: status.managed.accountId,
                emails: status.managed.emails,
                emailDomains: status.managed.emailDomains,
                teamMembers: status.managed.teamMembers,
                bypassPaths: status.bypassPaths,
              })
            }
          />
        ) : (
          <CustomerAppSummary status={status} />
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {(status.managed || connected) && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {status.managed ? "Edit" : "Let Creek manage it"}
            </Button>
          )}
          {confirmingOff ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {remove.isPending ? "Turning off…" : "Confirm: turn off protection"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingOff(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmingOff(true)}>
              Turn off protection
            </Button>
          )}
        </div>
        {confirmingOff && (
          <p className="text-xs text-muted-foreground">
            Anyone will be able to open this project's custom domains and preview URLs again.
            {status.managed && " Creek deletes the Access applications it made."}
          </p>
        )}
      </div>
    );
  }

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Protection
      </h2>
      <div className="space-y-4 rounded-lg border border-border p-4">
        <p className="text-sm text-muted-foreground">
          Put this project behind Cloudflare Access, so only the people you list can open it. While
          it is on, Creek also closes the project's preview URLs on bycreek.com.
        </p>
        {content}
        {remove.isError && (
          <Notice tone="error">Could not turn off protection: {errorMessage(remove.error)}</Notice>
        )}
        {remove.data?.cloudflareCleanup && (
          <Notice tone="error">
            {remove.data.cloudflareCleanup.message}{" "}
            <span className="font-mono text-xs">
              {remove.data.cloudflareCleanup.appIds.join(", ")}
            </span>
          </Notice>
        )}
      </div>
    </section>
  );
}

function Unprotected({
  hostnames,
  cloudflare,
  cloudflareLoading,
  onStart,
}: {
  hostnames: string[];
  cloudflare: CloudflareStatus | undefined;
  cloudflareLoading: boolean;
  onStart: () => void;
}) {
  if (!hostnames.length) {
    return (
      <p className="text-sm">
        Add a custom domain first. Access protects a domain on a zone in your own Cloudflare
        account.
      </p>
    );
  }
  if (cloudflareLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (!cloudflare?.configured) {
    return (
      <p className="text-sm text-muted-foreground">
        Cloudflare Access is not available on this Creek instance.
      </p>
    );
  }
  if (!cloudflare.connected || cloudflare.needsReauth) {
    return (
      <p className="text-sm">
        {cloudflare.connected ? "Reconnect" : "Connect"} your Cloudflare account under{" "}
        <Link to="/settings" className="underline">
          Settings → Cloudflare
        </Link>{" "}
        first: Creek makes the Access applications there, and Access seats are billed to that
        account.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Protects <HostList hostnames={hostnames} />.
      </p>
      <Button size="sm" onClick={onStart}>
        Protect with Cloudflare Access
      </Button>
    </div>
  );
}

function HostList({ hostnames }: { hostnames: string[] }) {
  return (
    <>
      {hostnames.map((h, i) => (
        <span key={h}>
          {i > 0 && ", "}
          <span className="font-mono text-xs">{h}</span>
        </span>
      ))}
    </>
  );
}

function ManagedSummary({
  status,
  syncing,
  syncError,
  onSync,
}: {
  status: Extract<AccessStatus, { managed: ManagedAccessView }>;
  syncing: boolean;
  syncError: unknown;
  onSync: () => void;
}) {
  const m = status.managed;
  const changed = [
    m.outOfSync.hostnames && "custom domains",
    m.outOfSync.members && "team members",
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      {changed.length > 0 && (
        <Notice tone="warn">
          <p>
            The project's {changed.join(" and ")} changed since Cloudflare was last updated, so
            Access still uses the old list.
          </p>
          <Button size="sm" variant="outline" className="mt-2" onClick={onSync} disabled={syncing}>
            {syncing ? "Updating…" : "Update Cloudflare"}
          </Button>
        </Notice>
      )}
      {!!syncError && <SaveError error={syncError} prefix="Update failed: " />}

      {status.noMailDomains.length > 0 && (
        <Notice tone="warn">
          These domains cannot receive email, so nobody on them can get a sign-in code:{" "}
          <span className="font-mono text-xs">{status.noMailDomains.join(", ")}</span>
        </Notice>
      )}
      {status.noMxDomains.length > 0 && (
        <Notice tone="warn">
          These domains have no mail server (MX) record, so a sign-in code sent to them most likely
          never arrives:{" "}
          <span className="font-mono text-xs">{status.noMxDomains.join(", ")}</span>
        </Notice>
      )}

      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Custom domains</dt>
          <dd>
            <HostList hostnames={status.hostnames} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Who can sign in</dt>
          <dd>
            <ul className="space-y-1">
              {m.teamMembers && (
                <li>
                  Everyone on this team
                  <span className="block font-mono text-xs text-muted-foreground">
                    {m.memberEmails.length ? m.memberEmails.join(", ") : "No members with an email"}
                  </span>
                  <MemberDrift
                    today={m.memberEmails}
                    applied={m.outOfSync.members ? m.appliedMemberEmails : null}
                  />
                </li>
              )}
              {m.emails.map((e) => (
                <li key={e} className="font-mono text-xs">
                  {e}
                </li>
              ))}
              {m.emailDomains.map((d) => (
                <li key={d}>
                  Anyone with an <span className="font-mono text-xs">@{d}</span> address
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Public paths</dt>
          <dd className="font-mono text-xs">
            {status.bypassPaths.length ? status.bypassPaths.join(", ") : "None"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cloudflare account</dt>
          <dd className="font-mono text-xs">{m.accountId}</dd>
        </div>
      </dl>

      <p className="text-xs text-muted-foreground">
        People sign in with a one-time PIN sent by email. Cloudflare sends it only to addresses on
        this list: anyone else is told a code was sent, but gets nothing.
      </p>
    </div>
  );
}

/**
 * Until Cloudflare is updated, it lets in the members of the last sync: name
 * who is listed but cannot sign in yet, and who left but still can.
 */
function MemberDrift({ today, applied }: { today: string[]; applied: string[] | null }) {
  if (!applied) return null;
  const notYet = today.filter((e) => !applied.includes(e));
  const stillIn = applied.filter((e) => !today.includes(e));
  return (
    <>
      {notYet.length > 0 && (
        <span className="block text-xs text-warning-foreground">
          Can't sign in until you update Cloudflare:{" "}
          <span className="font-mono">{notYet.join(", ")}</span>
        </span>
      )}
      {stillIn.length > 0 && (
        <span className="block text-xs text-warning-foreground">
          No longer on the team, but can still sign in until you update Cloudflare:{" "}
          <span className="font-mono">{stillIn.join(", ")}</span>
        </span>
      )}
    </>
  );
}

function CustomerAppSummary({ status }: { status: Extract<AccessStatus, { managed: null }> }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Uses an Access application you made in your own Cloudflare account. Change who can sign in
        there.
      </p>
      <dl className="space-y-2">
        <div>
          <dt className="text-muted-foreground">Custom domains</dt>
          <dd>
            <HostList hostnames={status.hostnames} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Application audience (AUD)</dt>
          <dd className="break-all font-mono text-xs">{status.aud}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Public paths</dt>
          <dd className="font-mono text-xs">
            {status.bypassPaths.length ? status.bypassPaths.join(", ") : "None"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function ProtectionForm({
  initial,
  bypassPaths,
  accounts,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: Extract<AccessStatus, { managed: ManagedAccessView }> | null;
  bypassPaths: string[];
  accounts: { id: string; name: string }[];
  pending: boolean;
  error: unknown;
  onSubmit: (body: ManagedBody) => void;
  onCancel: () => void;
}) {
  const m = initial?.managed;
  const [teamMembers, setTeamMembers] = useState(m ? m.teamMembers : true);
  const [emails, setEmails] = useState((m?.emails ?? []).join("\n"));
  const [domains, setDomains] = useState((m?.emailDomains ?? []).join("\n"));
  const [paths, setPaths] = useState(bypassPaths.join("\n"));
  const [accountId, setAccountId] = useState(m?.accountId ?? accounts[0]?.id ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: ManagedBody = {
      emails: splitList(emails),
      emailDomains: splitList(domains),
      teamMembers,
      bypassPaths: splitList(paths),
    };
    if (!body.teamMembers && !body.emails.length && !body.emailDomains.length) {
      setLocalError("Say who can sign in: the team, some emails, or an email domain.");
      return;
    }
    setLocalError(null);
    onSubmit(accountId ? { ...body, accountId } : body);
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      {accounts.length > 1 && (
        <div className="space-y-1">
          <label htmlFor="protection-account" className="text-sm font-medium">
            Cloudflare account
          </label>
          <select
            id="protection-account"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={accountId}
            disabled={!!m}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {m && (
            <p className="text-xs text-muted-foreground">
              To move to another account, turn protection off first.
            </p>
          )}
        </div>
      )}

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Who can sign in</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={teamMembers}
            onChange={(e) => setTeamMembers(e.target.checked)}
          />
          Everyone on this team
        </label>
        <div className="space-y-1">
          <label htmlFor="protection-emails" className="text-sm">
            Other people's emails
          </label>
          <Textarea
            id="protection-emails"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            placeholder={"alice@example.com\nbob@partner.io"}
            rows={3}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="protection-domains" className="text-sm">
            Everyone with an email on these domains
          </label>
          <Textarea
            id="protection-domains"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="example.com"
            rows={2}
          />
        </div>
      </fieldset>

      <div className="space-y-1">
        <label htmlFor="protection-paths" className="text-sm font-medium">
          Public paths
        </label>
        <Textarea
          id="protection-paths"
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
          placeholder={"/health\n/api/webhooks/*"}
          rows={2}
        />
        <p className="text-xs text-muted-foreground">
          Anyone can open these without signing in, and everything under them: /health also opens
          /health/live. One per line.
        </p>
      </div>

      {localError && <Notice tone="error">{localError}</Notice>}
      {!!error && <SaveError error={error} />}

      <div className="flex items-center gap-2">
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? "Saving…" : initial ? "Save" : "Turn on protection"}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Creek makes or updates the Access applications in your Cloudflare account. Changes take
        effect within about a minute.
      </p>
    </form>
  );
}

/** A refused save, with the Cloudflare setup link when the refusal carries one. */
function SaveError({ error, prefix = "" }: { error: unknown; prefix?: string }) {
  const setupUrl = setupUrlOf(error);
  return (
    <Notice tone="error">
      {prefix}
      {errorMessage(error)}
      {setupUrl && (
        <a
          href={setupUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 flex items-center gap-1 underline"
        >
          Open Cloudflare <ExternalLink className="size-3" />
        </a>
      )}
    </Notice>
  );
}

function Notice({ tone, children }: { tone: "ok" | "warn" | "error"; children: React.ReactNode }) {
  const Icon = tone === "ok" ? CheckCircle2 : AlertTriangle;
  const styles = {
    ok: "border-success/30 bg-success/5",
    warn: "border-warning/40 bg-warning/10",
    error: "border-destructive/30 bg-destructive/5",
  }[tone];
  const iconColor = {
    ok: "text-success-foreground",
    warn: "text-warning-foreground",
    error: "text-destructive",
  }[tone];
  return (
    <div
      role={tone === "ok" ? "status" : "alert"}
      className={`flex items-start gap-2 rounded-md border p-3 text-sm ${styles}`}
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${iconColor}`} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
