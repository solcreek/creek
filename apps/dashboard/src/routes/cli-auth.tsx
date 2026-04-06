import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth";
import { Button } from "@solcreek/ui/components/button";

export const Route = createFileRoute("/cli-auth")({
  validateSearch: (search: Record<string, unknown>) => ({
    port: Number(search.port) || 0,
    state: String(search.state || ""),
  }),
  component: CliAuthPage,
});

function CliAuthPage() {
  const { port, state } = Route.useSearch();
  const { data: session, isPending } = authClient.useSession();
  const [status, setStatus] = useState<"checking" | "creating" | "redirecting" | "done" | "error">("checking");
  const [error, setError] = useState("");

  useEffect(() => {
    if (isPending) return;

    if (!session?.user) {
      // Not logged in — the login page will handle it
      // Redirect to login with a return URL back here
      window.location.href = `/login?redirect=${encodeURIComponent(`/cli-auth?port=${port}&state=${state}`)}`;
      return;
    }

    if (!port || !state) {
      setStatus("error");
      setError("Missing port or state parameter. Please run `creek login` again.");
      return;
    }

    // User is authenticated — create API key and redirect to CLI
    createKeyAndRedirect();
  }, [session, isPending]);

  async function createKeyAndRedirect() {
    setStatus("creating");

    try {
      const result = await authClient.apiKey.create({
        name: `CLI (${new Date().toLocaleDateString()})`,
      });

      const key = (result.data as any)?.key;
      if (!key) {
        setStatus("error");
        setError("Failed to create API key. Please try again.");
        return;
      }

      setStatus("redirecting");

      // Redirect to CLI's local server with the key
      window.location.href = `http://localhost:${port}/callback?key=${encodeURIComponent(key)}&state=${encodeURIComponent(state)}`;

      // Show success state in case redirect is blocked
      setTimeout(() => setStatus("done"), 1000);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to create API key");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4 p-6 text-center">
        <h1 className="text-2xl font-bold">Creek CLI</h1>

        {status === "checking" && (
          <p className="text-muted-foreground">Checking authentication...</p>
        )}

        {status === "creating" && (
          <p className="text-muted-foreground">Creating API key...</p>
        )}

        {status === "redirecting" && (
          <p className="text-muted-foreground">Redirecting to CLI...</p>
        )}

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
            <Button
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
