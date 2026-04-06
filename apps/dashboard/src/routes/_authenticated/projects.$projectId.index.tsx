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
import { MoreHorizontal, ArrowUpCircle } from "lucide-react";

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

function DeploymentsTab() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();

  const { data: deployments, isLoading } = useQuery({
    queryKey: ["deployments", projectId],
    queryFn: () => api<Deployment[]>(`/projects/${projectId}/deployments`),
  });

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<{ productionDeploymentId: string | null }>(`/projects/${projectId}`),
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

  if (isLoading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (!deployments?.length) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <h3 className="font-semibold">No deployments yet</h3>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Deploy your project from the CLI:
        </p>
        <div className="mx-auto mt-3 max-w-xs rounded-md bg-code-bg px-3 py-2 text-left font-mono text-xs">
          <span className="text-muted-foreground">$</span> npx creek deploy
        </div>
      </div>
    );
  }

  const productionId = project?.productionDeploymentId;

  return (
    <div className="space-y-2">
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
