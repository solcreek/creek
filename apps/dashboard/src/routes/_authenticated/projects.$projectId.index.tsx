import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@solcreek/ui/components/dropdown-menu";
import { Button } from "@solcreek/ui/components/button";
import { MoreHorizontal, ArrowUpCircle, Rocket, Loader2 } from "lucide-react";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/",
)({
  component: DeploymentsTab,
});

interface Deployment {
  id: string;
  version: number;
  status: string;
  branch: string | null;
  triggerType: string;
  failedStep: string | null;
  errorMessage: string | null;
  createdAt: number;
  productionDeploymentId?: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500",
  queued: "bg-yellow-500",
  uploading: "bg-blue-500",
  provisioning: "bg-blue-500",
  deploying: "bg-blue-500",
  failed: "bg-red-500",
  cancelled: "bg-gray-500",
};

// Statuses that indicate a deployment is still in flight and should trigger
// polling so the dashboard reflects progress without a manual refresh.
const IN_FLIGHT_STATUSES = new Set(["queued", "uploading", "provisioning", "deploying"]);

function DeploymentsTab() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();

  const { data: deployments, isLoading } = useQuery({
    queryKey: ["deployments", projectId],
    queryFn: () => api<Deployment[]>(`/projects/${projectId}/deployments`),
    // Poll every 2s while any deployment is in flight, stop otherwise.
    refetchInterval: (query) => {
      const data = query.state.data as Deployment[] | undefined;
      return data?.some((d) => IN_FLIGHT_STATUSES.has(d.status)) ? 2000 : false;
    },
  });

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<{ productionDeploymentId: string | null; githubRepo: string | null }>(`/projects/${projectId}`),
  });

  const promote = useMutation({
    mutationFn: (deploymentId: string) =>
      api(`/projects/${projectId}/deployments/${deploymentId}/promote`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const deployLatest = useMutation({
    mutationFn: () =>
      api("/github/deploy-latest", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      }),
    onSuccess: () => {
      // Kick the deployments query immediately so polling starts.
      queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
    },
  });

  const hasGithub = !!project?.githubRepo;
  const deployError = (deployLatest.error as Error | null)?.message;

  const DeployButton = () => (
    <Button
      size="sm"
      onClick={() => deployLatest.mutate()}
      disabled={!hasGithub || deployLatest.isPending}
      title={hasGithub ? undefined : "Connect a GitHub repository in Settings to enable deploys"}
    >
      {deployLatest.isPending ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          Triggering...
        </>
      ) : (
        <>
          <Rocket className="mr-2 size-4" />
          Deploy latest
        </>
      )}
    </Button>
  );

  if (isLoading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (!deployments?.length) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Deployments</h2>
          <DeployButton />
        </div>
        {deployError && (
          <p className="text-sm text-destructive">Deploy failed: {deployError}</p>
        )}
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <h3 className="font-semibold">No deployments yet</h3>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            {hasGithub
              ? "Click Deploy latest above to build the current HEAD of your production branch."
              : "Connect a GitHub repository in Settings or run from the CLI:"}
          </p>
          {!hasGithub && (
            <div className="mx-auto mt-3 max-w-xs rounded-md bg-code-bg px-3 py-2 text-left font-mono text-xs">
              <span className="text-muted-foreground">$</span> npx creek deploy
            </div>
          )}
        </div>
      </div>
    );
  }

  const productionId = project?.productionDeploymentId;

  return (
    <div className="space-y-2">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Deployments</h2>
        <DeployButton />
      </div>
      {deployError && (
        <p className="text-sm text-destructive">Deploy failed: {deployError}</p>
      )}
      {deployments.map((d) => {
        const isProduction = d.id === productionId;
        const canPromote = d.status === "active" && !isProduction;

        return (
          <div
            key={d.id}
            className="flex items-center justify-between rounded-lg border border-border p-3"
          >
            <div className="flex items-center gap-3">
              <span
                className={`size-2.5 rounded-full ${STATUS_COLORS[d.status] ?? "bg-gray-400"}`}
              />
              <div>
                <p className="text-sm font-medium">
                  v{d.version}
                  {d.branch && (
                    <span className="ml-2 text-muted-foreground">{d.branch}</span>
                  )}
                  {isProduction && (
                    <span className="ml-2 rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-400">
                      Production
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {d.triggerType} &middot; {d.status}
                  {d.failedStep && ` at ${d.failedStep}`}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{d.id.slice(0, 8)}</span>
              {canPromote && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={
                    <Button variant="ghost" size="icon-xs">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  } />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => promote.mutate(d.id)}
                      disabled={promote.isPending}
                    >
                      <ArrowUpCircle className="mr-2 size-4" />
                      {promote.isPending ? "Promoting..." : "Promote to Production"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
