import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@solcreek/ui/components/button";
import { useApiMode } from "@/lib/api-context";

export function ConnectionError({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const mode = useApiMode();
  const isNetworkError =
    error.message.includes("fetch") ||
    error.message.includes("network") ||
    error.message.includes("Failed") ||
    error.message.includes("Cannot connect") ||
    error.message.includes("ECONNREFUSED");

  const title = isNetworkError
    ? mode === "creekd"
      ? "Cannot connect to creekd"
      : "Cannot reach API"
    : "Something went wrong";

  const hint =
    isNetworkError && mode === "creekd"
      ? "Make sure creekd is running on this machine."
      : undefined;

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{error.message}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{hint}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-4">
          <RefreshCw className="mr-2 size-4" />
          Retry
        </Button>
      )}
    </div>
  );
}
