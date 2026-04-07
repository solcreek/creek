import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Rocket, ExternalLink, Clock, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/deployments")({
  component: DeploymentsPage,
});

interface WebDeploy {
  buildId: string;
  status: string;
  type?: string;
  previewUrl?: string;
  sandboxId?: string;
  expiresAt?: string;
  error?: string;
  failedStep?: string;
  createdAt?: string;
  updatedAt?: string;
}

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
  building: { icon: Loader2, color: "text-blue-400", label: "Building" },
  deploying: { icon: Loader2, color: "text-yellow-400", label: "Deploying" },
  active: { icon: CheckCircle2, color: "text-green-400", label: "Active" },
  failed: { icon: AlertCircle, color: "text-red-400", label: "Failed" },
};

function DeploymentsPage() {
  const { data: deploys, isLoading } = useQuery({
    queryKey: ["web-deploys"],
    queryFn: () => api<WebDeploy[]>("/web-deploy/list"),
    refetchInterval: 5000,
  });

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Web Deploys</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Recent web deploys from creek.dev/new (last hour)
        </p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : !deploys?.length ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-secondary">
            <Rocket className="size-6 text-muted-foreground" />
          </div>
          <h3 className="font-semibold">No recent web deploys</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Web deploys from creek.dev/new will appear here for 1 hour.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {deploys.map((deploy) => {
            const config = STATUS_CONFIG[deploy.status] || STATUS_CONFIG.building;
            const Icon = config.icon;
            const isSpinning = deploy.status === "building" || deploy.status === "deploying";
            const timeAgo = deploy.createdAt ? formatTimeAgo(deploy.createdAt) : deploy.updatedAt ? formatTimeAgo(deploy.updatedAt) : "";

            return (
              <div
                key={deploy.buildId}
                className="flex items-center justify-between rounded-lg border border-border px-4 py-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className={`size-4 shrink-0 ${config.color} ${isSpinning ? "animate-spin" : ""}`} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{deploy.buildId}</span>
                      <span className={`text-xs font-medium ${config.color}`}>{config.label}</span>
                      {deploy.type && (
                        <span className="text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                          {deploy.type}
                        </span>
                      )}
                    </div>
                    {deploy.error && (
                      <p className="text-xs text-red-400 mt-0.5 truncate">{deploy.error}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 ml-4">
                  {deploy.previewUrl && (
                    <a
                      href={deploy.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ExternalLink className="size-3" />
                      Preview
                    </a>
                  )}
                  {timeAgo && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3" />
                      {timeAgo}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
