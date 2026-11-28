import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@solcreek/ui/components/button";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";

interface CloudflareAccount {
  id: string;
  name: string;
}

/** GET /integrations/cloudflare. Never carries a token. */
export type CloudflareStatus =
  | { configured: boolean; connected: false }
  | {
      configured: boolean;
      connected: true;
      accounts: CloudflareAccount[];
      grantedScopes: string[];
      connectedByUserId: string;
      createdAt: number;
      updatedAt: number;
      needsReauth: boolean;
    };

interface VerifyResult {
  ok: true;
  accounts: CloudflareAccount[];
}

/** Where the OAuth callback sends the browser back: `?cloudflare=connected` or `?cloudflare_error=<code>`. */
export interface CloudflareCallbackResult {
  connected?: boolean;
  error?: string;
}

const CALLBACK_ERRORS: Record<string, string> = {
  denied: "You declined the authorization on Cloudflare.",
  expired: "The authorization took too long. Start again.",
  invalid_state: "The authorization link was invalid or already used. Start again.",
  session_mismatch:
    "The authorization was started by a different signed-in user. Start again from this account.",
  forbidden: "You need permission to manage domains on this team to connect Cloudflare.",
  authorization_failed: "Cloudflare did not complete the authorization. Start again.",
  token_exchange_failed: "Cloudflare refused the authorization code. Start again.",
  storage_failed: "Creek could not save the connection. Start again.",
};

const STATUS_KEY = ["integrations", "cloudflare"] as const;

export interface CloudflareTeam {
  id: string;
  slug: string;
}

/** The query string is user-controlled: only own keys, so `__proto__` or `constructor` gets the fallback. */
function callbackErrorMessage(code: string): string {
  return Object.hasOwn(CALLBACK_ERRORS, code)
    ? CALLBACK_ERRORS[code]
    : `Connecting Cloudflare failed (${code}).`;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You don't have permission to do this on this team.";
    return err.message || err.code;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Connect the team's own Cloudflare account through OAuth. Access seats and
 * DNS changes are made in that account, so its owner is billed, not Creek.
 */
export function CloudflarePanel({
  team,
  callback,
  onDismissCallback,
}: {
  /**
   * The team this panel shows and acts on. Every request names it with
   * x-creek-team rather than relying on the session's active organization,
   * which another tab can change while this one still shows the old team.
   * Render with key={team.id} so a team switch starts from clean state.
   */
  team: CloudflareTeam;
  callback?: CloudflareCallbackResult;
  onDismissCallback?: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const statusKey = [...STATUS_KEY, team.id];

  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => api<CloudflareStatus>("/integrations/cloudflare", { team: team.slug }),
  });

  const authorize = useMutation({
    mutationFn: () =>
      api<{ url: string }>("/integrations/cloudflare/authorize", {
        method: "POST",
        team: team.slug,
        body: JSON.stringify({ returnTo: "/settings" }),
      }),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });

  const verify = useMutation({
    mutationFn: () =>
      api<VerifyResult>("/integrations/cloudflare/verify", { method: "POST", team: team.slug }),
    // A 409 means the grant can no longer be renewed: show the reconnect state.
    onError: (err) => {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        void queryClient.invalidateQueries({ queryKey: statusKey });
      }
    },
  });

  const disconnect = useMutation({
    mutationFn: () =>
      api<{ ok: true; revoked: boolean }>("/integrations/cloudflare", {
        method: "DELETE",
        team: team.slug,
      }),
    onSettled: () => {
      setConfirmingDisconnect(false);
      verify.reset();
      void queryClient.invalidateQueries({ queryKey: statusKey });
    },
  });

  const data = status.data;

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Cloudflare
      </h2>
      <div className="space-y-4 rounded-lg border border-border p-4">
        <p className="text-sm text-muted-foreground">
          Connect your own Cloudflare account to put deployments behind Cloudflare Access, so only
          the people you choose can sign in. Access seats are billed to your account.
        </p>

        {callback?.connected && (
          <Notice tone="ok" onDismiss={onDismissCallback}>
            Cloudflare connected.
          </Notice>
        )}
        {callback?.error && (
          <Notice tone="error" onDismiss={onDismissCallback}>
            {callbackErrorMessage(callback.error)}
          </Notice>
        )}

        {status.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : status.error ? (
          <p className="text-sm text-destructive">
            Could not load the Cloudflare connection: {errorMessage(status.error)}
          </p>
        ) : !data?.configured ? (
          <p className="text-sm text-muted-foreground">
            Cloudflare integration is not available on this Creek instance.
          </p>
        ) : !data.connected ? (
          <Button size="sm" onClick={() => authorize.mutate()} disabled={authorize.isPending}>
            {authorize.isPending ? "Redirecting…" : "Connect Cloudflare"}
          </Button>
        ) : (
          <div className="space-y-4">
            {data.needsReauth ? (
              <Notice tone="error">
                The connection expired and can't be renewed. Reconnect to keep using it.
              </Notice>
            ) : (
              <p className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="size-4 text-green-400" /> Connected
              </p>
            )}

            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Accounts</dt>
                <dd>
                  {data.accounts.length === 0
                    ? "None"
                    : data.accounts.map((a) => (
                        <span key={a.id} className="block">
                          {a.name}{" "}
                          <span className="font-mono text-xs text-muted-foreground">{a.id}</span>
                        </span>
                      ))}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Connected on</dt>
                <dd>{new Date(data.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Permissions</dt>
                <dd className="font-mono text-xs">{data.grantedScopes.join(", ")}</dd>
              </div>
            </dl>

            <div className="flex flex-wrap items-center gap-2">
              {data.needsReauth ? (
                <Button size="sm" onClick={() => authorize.mutate()} disabled={authorize.isPending}>
                  {authorize.isPending ? "Redirecting…" : "Reconnect"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => verify.mutate()}
                  disabled={verify.isPending}
                >
                  {verify.isPending ? "Testing…" : "Test connection"}
                </Button>
              )}
              {confirmingDisconnect ? (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending}
                  >
                    {disconnect.isPending ? "Disconnecting…" : "Confirm disconnect"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingDisconnect(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirmingDisconnect(true)}>
                  Disconnect
                </Button>
              )}
            </div>

            {verify.isSuccess && (
              <Notice tone="ok">
                Working. It reaches {verify.data.accounts.length}{" "}
                {verify.data.accounts.length === 1 ? "account" : "accounts"}.
              </Notice>
            )}
            {verify.isError && (
              <Notice tone="error">Test failed: {errorMessage(verify.error)}</Notice>
            )}
          </div>
        )}

        {authorize.isError && (
          <Notice tone="error">Could not start: {errorMessage(authorize.error)}</Notice>
        )}
        {disconnect.isError && (
          <Notice tone="error">Disconnect failed: {errorMessage(disconnect.error)}</Notice>
        )}
        {disconnect.isSuccess && (
          <Notice tone={disconnect.data.revoked ? "ok" : "error"}>
            {disconnect.data.revoked
              ? "Cloudflare disconnected."
              : "Disconnected, but Cloudflare did not confirm the revocation. Revoke Creek under Profile → Connected applications in the Cloudflare dashboard."}
          </Notice>
        )}
      </div>
    </section>
  );
}

function Notice({
  tone,
  children,
  onDismiss,
}: {
  tone: "ok" | "error";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = tone === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        "flex items-start gap-2 rounded-md border p-3 text-sm " +
        (tone === "ok"
          ? "border-green-500/30 bg-green-500/5"
          : "border-destructive/30 bg-destructive/5")
      }
    >
      <Icon
        className={
          "mt-0.5 size-4 shrink-0 " + (tone === "ok" ? "text-green-400" : "text-destructive")
        }
      />
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
