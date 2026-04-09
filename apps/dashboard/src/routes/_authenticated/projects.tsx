import { createFileRoute, Link, Outlet, useMatch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { Folder } from "lucide-react";

export const Route = createFileRoute("/_authenticated/projects")({
  component: ProjectsPage,
});

interface Project {
  id: string;
  slug: string;
  framework: string | null;
  productionDeploymentId: string | null;
  createdAt: number;
  updatedAt: number;
}

function ProjectsPage() {
  // Check if we're on a child route (e.g., /projects/$projectId)
  const childMatch = useMatch({ from: "/_authenticated/projects/$projectId", shouldThrow: false });

  // If on a child route, render the child via Outlet
  if (childMatch) {
    return <Outlet />;
  }

  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/projects"),
  });

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <NewProjectDialog />
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : !projects?.length ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-secondary">
            <Folder className="size-6 text-muted-foreground" />
          </div>
          <h3 className="font-semibold">No projects yet</h3>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            Get started by creating a project here, or initialize one from the CLI:
          </p>
          <div className="mx-auto mt-4 max-w-xs space-y-2">
            <div className="rounded-md bg-code-bg px-3 py-2 text-left font-mono text-xs">
              <span className="text-muted-foreground">$</span> npx creek init
            </div>
            <div className="rounded-md bg-code-bg px-3 py-2 text-left font-mono text-xs">
              <span className="text-muted-foreground">$</span> npx creek deploy
            </div>
          </div>
          <div className="mt-4">
            <NewProjectDialog />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map((project) => (
            <Link
              key={project.id}
              to="/projects/$projectId"
              params={{ projectId: project.slug }}
              className="flex items-center justify-between rounded-lg border border-border p-4 transition-colors hover:bg-card"
            >
              <div>
                <p className="font-medium">{project.slug}</p>
                <p className="text-sm text-muted-foreground">
                  {project.framework ?? "static"}
                </p>
              </div>
              <div className="text-right text-sm text-muted-foreground">
                {project.productionDeploymentId ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="size-2 rounded-full bg-green-500" />
                    Live
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not deployed</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
