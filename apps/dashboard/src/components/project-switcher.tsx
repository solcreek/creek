import { useState, useMemo } from "react";
import { Link, useParams, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@solcreek/ui/components/dropdown-menu";
import { Input } from "@solcreek/ui/components/input";
import { ChevronsUpDown, Folder, Plus, Search } from "lucide-react";

interface Project {
  id: string;
  slug: string;
  framework: string | null;
}

const FRAMEWORK_COLORS: Record<string, string> = {
  "vite-react": "bg-blue-500",
  "nextjs": "bg-white text-black",
  "react-router": "bg-red-500",
  "tanstack-start": "bg-orange-500",
  "sveltekit": "bg-orange-600",
  "nuxt": "bg-green-500",
  "vite-vue": "bg-green-500",
  "vite-svelte": "bg-orange-500",
  "vite-solid": "bg-blue-400",
  "solidstart": "bg-blue-400",
};

function FrameworkIcon({ framework, slug }: { framework: string | null; slug: string }) {
  const letter = slug[0]?.toUpperCase() ?? "?";
  const color = framework ? (FRAMEWORK_COLORS[framework] ?? "bg-muted") : "bg-muted";

  return (
    <div className={`flex size-6 items-center justify-center rounded text-[10px] font-bold ${color}`}>
      {letter}
    </div>
  );
}

export function ProjectSwitcher() {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const projectId = (params as any).projectId as string | undefined;

  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/projects"),
  });

  const filtered = useMemo(() => {
    if (!projects) return [];
    if (!search) return projects;
    const q = search.toLowerCase();
    return projects.filter((p) => p.slug.toLowerCase().includes(q));
  }, [projects, search]);

  const activeProject = projects?.find((p) => p.slug === projectId || p.id === projectId);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-secondary transition-colors">
            {activeProject ? (
              <>
                <FrameworkIcon framework={activeProject.framework} slug={activeProject.slug} />
                <span className="font-medium">{activeProject.slug}</span>
              </>
            ) : (
              <>
                <Folder className="size-4 text-muted-foreground" />
                <span>All Projects</span>
              </>
            )}
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent className="w-72" align="start">
        {/* Search */}
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Search className="size-4 text-muted-foreground" />
          <Input
            placeholder="Find Project..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
        <DropdownMenuSeparator />

        {/* Project list */}
        <div className="max-h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {search ? "No projects found." : "No projects yet."}
            </div>
          ) : (
            filtered.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => {
                  navigate({
                    to: "/projects/$projectId",
                    params: { projectId: project.slug },
                  });
                  setOpen(false);
                  setSearch("");
                }}
                className={project.slug === activeProject?.slug ? "bg-secondary" : ""}
              >
                <FrameworkIcon framework={project.framework} slug={project.slug} />
                <span className="truncate">{project.slug}</span>
              </DropdownMenuItem>
            ))
          )}
        </div>

        {/* Create project */}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          render={<Link to="/projects" />}
          onClick={() => {
            setOpen(false);
            setSearch("");
          }}
        >
          <Plus className="size-4" />
          <span>Create Project</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
