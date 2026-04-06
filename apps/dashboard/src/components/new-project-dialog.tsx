import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@solcreek/ui/components/dialog";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";
import { api } from "@/lib/api";
import { Plus } from "lucide-react";

const FRAMEWORKS = [
  { value: "", label: "Auto-detect (recommended)" },
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

export function NewProjectDialog() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [framework, setFramework] = useState("");
  const [error, setError] = useState("");

  const createProject = useMutation({
    mutationFn: (data: { slug: string; framework?: string }) =>
      api<{ project: { id: string; slug: string } }>("/projects", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      setSlug("");
      setFramework("");
      setError("");
      navigate({
        to: "/projects/$projectId",
        params: { projectId: res.project.slug },
      });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to create project");
    },
  });

  const normalizedSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!normalizedSlug) return;

    const data: { slug: string; framework?: string } = { slug: normalizedSlug };
    if (framework) data.framework = framework;
    createProject.mutate(data);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="size-4" data-icon="inline-start" />
            New Project
          </Button>
        }
      />
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription>
              Give your project a name. You can deploy to it using the CLI.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Project Name</label>
              <Input
                placeholder="my-app"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
              />
              {slug && slug !== normalizedSlug && (
                <p className="text-xs text-muted-foreground">
                  Will be created as: <code className="rounded bg-code-bg px-1">{normalizedSlug}</code>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Framework</label>
              <select
                value={framework}
                onChange={(e) => setFramework(e.target.value)}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/50"
              >
                {FRAMEWORKS.map((fw) => (
                  <option key={fw.value} value={fw.value}>
                    {fw.label}
                  </option>
                ))}
              </select>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter className="mt-4">
            <Button
              type="submit"
              disabled={!slug || createProject.isPending}
            >
              {createProject.isPending ? "Creating..." : "Create Project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
