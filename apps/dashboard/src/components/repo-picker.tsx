import { useState } from "react";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";
import { Search, Lock, Globe, ArrowRight } from "lucide-react";

interface RepoScan {
  framework: string | null;
  configType: string | null;
  bindings: Array<{ type: string; name: string }>;
  envHints: string[];
  deployable: boolean;
}

interface Repo {
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  language: string | null;
  pushed_at: string | null;
  scan: RepoScan | null;
}

interface RepoPickerProps {
  repos: Repo[];
  installationId: number;
  onImport: (repo: { owner: string; name: string; defaultBranch: string }) => void;
}

const FRAMEWORK_LABELS: Record<string, string> = {
  nextjs: "Next.js",
  nuxt: "Nuxt",
  "react-router": "React Router",
  "tanstack-start": "TanStack Start",
  sveltekit: "SvelteKit",
  solidstart: "SolidStart",
  "vite-react": "Vite + React",
  "vite-vue": "Vite + Vue",
  "vite-svelte": "Vite + Svelte",
  "vite-solid": "Vite + Solid",
};

export function RepoPicker({ repos, installationId, onImport }: RepoPickerProps) {
  const [search, setSearch] = useState("");

  const filtered = repos.filter((repo) =>
    repo.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div>
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-10"
          placeholder="Search repositories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="rounded-lg border divide-y">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground">
            {search ? "No matching repositories" : "No repositories found"}
          </div>
        ) : (
          filtered.map((repo) => {
            const [owner] = repo.full_name.split("/");
            return (
              <div
                key={repo.full_name}
                className="flex items-center gap-4 p-4 hover:bg-accent/50 transition-colors"
              >
                {/* Visibility icon */}
                {repo.private ? (
                  <Lock className="size-4 text-muted-foreground shrink-0" />
                ) : (
                  <Globe className="size-4 text-muted-foreground shrink-0" />
                )}

                {/* Repo info */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{repo.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {/* Framework badge */}
                    {repo.scan?.framework && (
                      <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {FRAMEWORK_LABELS[repo.scan.framework] ?? repo.scan.framework}
                      </span>
                    )}
                    {/* Binding badges */}
                    {repo.scan?.bindings?.map((b) => (
                      <span
                        key={b.name}
                        className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {b.type.toUpperCase()}
                      </span>
                    ))}
                    {/* Time ago */}
                    {repo.pushed_at && (
                      <span className="text-xs text-muted-foreground">
                        {timeAgo(new Date(repo.pushed_at))}
                      </span>
                    )}
                  </div>
                </div>

                {/* Import button */}
                <Button
                  size="sm"
                  onClick={() => onImport({ owner, name: repo.name, defaultBranch: repo.default_branch })}
                >
                  Import <ArrowRight className="ml-1 size-3" />
                </Button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
