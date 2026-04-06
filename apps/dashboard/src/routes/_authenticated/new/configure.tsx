import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";
import { Loader2, ArrowLeft, Rocket } from "lucide-react";

export const Route = createFileRoute("/_authenticated/new/configure")({
  component: ConfigurePage,
  validateSearch: (search: Record<string, unknown>) => ({
    url: (search.url as string) || undefined,
    installation_id: search.installation_id ? Number(search.installation_id) : undefined,
    owner: (search.owner as string) || undefined,
    repo: (search.repo as string) || undefined,
  }),
});

const FRAMEWORKS = [
  { value: "", label: "Auto-detect" },
  { value: "vite-react", label: "Vite + React" },
  { value: "nextjs", label: "Next.js" },
  { value: "react-router", label: "React Router" },
  { value: "tanstack-start", label: "TanStack Start" },
  { value: "sveltekit", label: "SvelteKit" },
  { value: "nuxt", label: "Nuxt" },
  { value: "vite-vue", label: "Vite + Vue" },
  { value: "vite-svelte", label: "Vite + Svelte" },
  { value: "vite-solid", label: "Vite + Solid" },
  { value: "solidstart", label: "SolidStart" },
];

function ConfigurePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { url, installation_id, owner, repo } = Route.useSearch();

  // If coming from GitHub import, fetch scan data
  const { data: scanData } = useQuery({
    queryKey: ["repo-scan", owner, repo],
    queryFn: async () => {
      if (!installation_id || !owner || !repo) return null;
      const repos = await api<any[]>(`/github/installations/${installation_id}/repos`);
      return repos.find((r: any) => r.name === repo)?.scan ?? null;
    },
    enabled: !!installation_id && !!owner && !!repo,
  });

  // Form state — auto-filled from scan
  const [slug, setSlug] = useState(
    (repo || url?.split("/").pop()?.replace(".git", "") || "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-"),
  );
  const [framework, setFramework] = useState(scanData?.framework ?? "");
  const [branch, setBranch] = useState("main");
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState("");
  const [deploying, setDeploying] = useState(false);

  // Auto-fill when scan data arrives
  if (scanData && !framework && scanData.framework) {
    setFramework(scanData.framework);
  }
  if (scanData?.envHints?.length && envVars.length === 0) {
    setEnvVars(scanData.envHints.map((key: string) => ({ key, value: "" })));
  }

  const createAndDeploy = useMutation({
    mutationFn: async () => {
      setDeploying(true);
      setError("");

      // 1. Create project
      const projectRes = await api<{ project: { id: string; slug: string } }>("/projects", {
        method: "POST",
        body: JSON.stringify({
          slug,
          framework: framework || undefined,
          githubRepo: owner && repo ? `${owner}/${repo}` : undefined,
        }),
      });

      const projectId = projectRes.project.id;

      // 2. Connect GitHub repo (if from import)
      if (installation_id && owner && repo) {
        await api("/github/connect", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            installationId: installation_id,
            repoOwner: owner,
            repoName: repo,
            productionBranch: branch,
          }),
        });
      }

      // 3. Set env vars
      for (const ev of envVars) {
        if (ev.key && ev.value) {
          await api(`/projects/${projectId}/env`, {
            method: "POST",
            body: JSON.stringify({ key: ev.key, value: ev.value }),
          });
        }
      }

      return projectRes.project;
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
    onError: (err: any) => {
      setError(err.message || "Failed to create project");
      setDeploying(false);
    },
  });

  const repoDisplay = owner && repo ? `${owner}/${repo}` : url || "manual";

  return (
    <div className="mx-auto max-w-2xl p-6">
      <button
        className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        onClick={() => navigate({ to: "/new" })}
      >
        <ArrowLeft className="size-4" /> Back
      </button>

      <h1 className="text-xl font-semibold">Configure Project</h1>
      <p className="mt-1 mb-6 text-muted-foreground">
        Deploying from <span className="font-mono text-foreground">{repoDisplay}</span>
      </p>

      <div className="space-y-6">
        {/* Project name */}
        <div>
          <label className="mb-1 block text-sm font-medium">Project Name</label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            placeholder="my-app"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            URL: {slug}-team.bycreek.com
          </p>
        </div>

        {/* Framework */}
        <div>
          <label className="mb-1 block text-sm font-medium">Framework</label>
          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={framework}
            onChange={(e) => setFramework(e.target.value)}
          >
            {FRAMEWORKS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
                {scanData?.framework === f.value ? " (detected)" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Production branch */}
        <div>
          <label className="mb-1 block text-sm font-medium">Production Branch</label>
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
          />
        </div>

        {/* Environment variables */}
        {envVars.length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium">
              Environment Variables
              <span className="ml-1 text-xs text-muted-foreground">(from .env.example)</span>
            </label>
            <div className="space-y-2">
              {envVars.map((ev, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    className="flex-1 font-mono text-xs"
                    value={ev.key}
                    readOnly
                    tabIndex={-1}
                  />
                  <Input
                    className="flex-1"
                    value={ev.value}
                    onChange={(e) => {
                      const next = [...envVars];
                      next[i] = { ...ev, value: e.target.value };
                      setEnvVars(next);
                    }}
                    placeholder="value"
                    type="password"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Bindings info */}
        {scanData?.bindings?.length > 0 && (
          <div className="rounded-md bg-secondary/50 p-3">
            <p className="text-sm font-medium">Detected Bindings</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {scanData.bindings.map((b: any) => (
                <span
                  key={b.name}
                  className="rounded-full bg-background px-2 py-0.5 text-xs border"
                >
                  {b.type.toUpperCase()}: {b.name}
                </span>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Creek will auto-provision these resources.
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <Button
          className="w-full"
          size="lg"
          onClick={() => createAndDeploy.mutate()}
          disabled={!slug || deploying}
        >
          {deploying ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Creating project...
            </>
          ) : (
            <>
              <Rocket className="mr-2 size-4" />
              Deploy
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
