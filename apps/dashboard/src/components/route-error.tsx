import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";
import { Button } from "@solcreek/ui/components/button";

function ErrorCard({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const message =
    error instanceof Error ? error.message : String(error || "An unexpected error occurred.");

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" />
      </div>
      <h3 className="font-semibold">Something went wrong</h3>
      <p className="mx-auto mt-2 max-w-md break-words text-sm text-muted-foreground">{message}</p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          <RefreshCw className="mr-2 size-4" />
          Try again
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            reset();
            void router.navigate({ to: "/projects" });
          }}
        >
          <Home className="mr-2 size-4" />
          Go to Projects
        </Button>
      </div>
    </div>
  );
}

/** In-shell route error fallback rendered inside AppShell. */
export function RouteErrorFallback(props: ErrorComponentProps) {
  return (
    <div className="p-6">
      <ErrorCard {...props} />
    </div>
  );
}

/** Full-viewport error fallback for root or shell-level route failures. */
export function FullScreenErrorFallback(props: ErrorComponentProps) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md">
        <ErrorCard {...props} />
      </div>
    </div>
  );
}
