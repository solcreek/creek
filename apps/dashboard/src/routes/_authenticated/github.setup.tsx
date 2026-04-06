import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { RepoPicker } from "@/components/repo-picker";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/github/setup")({
  component: GitHubSetupPage,
  validateSearch: (search: Record<string, unknown>) => ({
    installation_id: Number(search.installation_id) || 0,
  }),
});

function GitHubSetupPage() {
  const { installation_id } = Route.useSearch();
  const navigate = useNavigate();
  const [claimed, setClaimed] = useState(false);

  // Claim the installation for the current team
  const claimMutation = useMutation({
    mutationFn: () =>
      api(`/github/installations/${installation_id}/claim`, { method: "POST" }),
    onSuccess: () => setClaimed(true),
    onError: (err: any) => {
      // Already claimed is fine
      if (err.status === 409) setClaimed(true);
    },
  });

  useEffect(() => {
    if (installation_id && !claimed) {
      claimMutation.mutate();
    }
  }, [installation_id]);

  // Fetch repos once claimed
  const { data: repos, isLoading } = useQuery({
    queryKey: ["github-repos", installation_id],
    queryFn: () => api<any[]>(`/github/installations/${installation_id}/repos`),
    enabled: claimed,
  });

  if (!installation_id) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-center">
        <h1 className="text-xl font-semibold">GitHub Setup</h1>
        <p className="mt-2 text-muted-foreground">
          Missing installation ID. Please install the Creek GitHub App first.
        </p>
      </div>
    );
  }

  if (!claimed || isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="mr-2 size-5 animate-spin" />
        <span className="text-muted-foreground">Loading repositories...</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Import Repository</h1>
        <p className="mt-1 text-muted-foreground">
          Select a repository to deploy. Creek auto-detects your framework and configuration.
        </p>
      </div>

      <RepoPicker
        repos={repos ?? []}
        installationId={installation_id}
        onImport={(repo) => {
          navigate({
            to: "/new/configure",
            search: {
              url: undefined,
              installation_id,
              owner: repo.owner,
              repo: repo.name,
            },
          });
        }}
      />
    </div>
  );
}
