import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth";
import { Button } from "@solcreek/ui/components/button";

export const Route = createFileRoute("/cli-auth")({
  validateSearch: (search: Record<string, unknown>) => ({
    port: Number(search.port) || 0,
    state: String(search.state || ""),
  }),
  component: CliAuthPage,
});

const MISSING_PARAMS_ERROR = "Missing port or state parameter. Please run `creek login` again.";

type KeyOutcome =
  | { status: "creating" }
  | { status: "redirecting" }
  | { status: "done" }
  | { status: "error"; error: string };

function CliAuthPage() {
  const { port, state } = Route.useSearch();
  const { data: session, isPending } = authClient.useSession();
  const [outcome, setOutcome] = useState<KeyOutcome>({ status: "creating" });
  // Create the key at most once, even if the session object is refreshed.
  const startedRef = useRef(false);
  const paramsMissing = !port || !state;

  useEffect(() => {
    if (isPending) return;

    if (!session?.user) {
      // Not logged in — the login page will handle it
      // Redirect to login with a return URL back here
      window.location.href = `/login?redirect=${encodeURIComponent(`/cli-auth?port=${port}&state=${state}`)}`;
      return;
    }

    if (paramsMissing || startedRef.current) return;
    startedRef.current = true;

    // User is authenticated — create API key and redirect to CLI
    authClient.apiKey
      .create({ name: `CLI (${new Date().toLocaleDateString()})` })
      .then((result) => {
        const key = (result.data as any)?.key;
        if (!key) {
          setOutcome({ status: "error", error: "Failed to create API key. Please try again." });
          return;
        }

        setOutcome({ status: "redirecting" });

        // Redirect to CLI's local server with the key
        window.location.href = `http://localhost:${port}/callback?key=${encodeURIComponent(key)}&state=${encodeURIComponent(state)}`;

        // Show success state in case redirect is blocked
        setTimeout(() => setOutcome({ status: "done" }), 1000);
      })
      .catch((err: unknown) => {
        setOutcome({
          status: "error",
          error: err instanceof Error ? err.message : "Failed to create API key",
        });
      });
  }, [session, isPending, port, state, paramsMissing]);

  const status =
    isPending || !session?.user ? "checking" : paramsMissing ? "error" : outcome.status;
  const error = paramsMissing
    ? MISSING_PARAMS_ERROR
    : outcome.status === "error"
      ? outcome.error
      : "";

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4 p-6 text-center">
        <h1 className="text-2xl font-bold">Creek CLI</h1>

        {status === "checking" && (
          <p className="text-muted-foreground">Checking authentication...</p>
        )}

        {status === "creating" && <p className="text-muted-foreground">Creating API key...</p>}

        {status === "redirecting" && <p className="text-muted-foreground">Redirecting to CLI...</p>}

        {status === "done" && (
          <div className="space-y-2">
            <p className="text-green-400">Authenticated!</p>
            <p className="text-sm text-muted-foreground">
              You can close this window and return to the terminal.
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-3">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
