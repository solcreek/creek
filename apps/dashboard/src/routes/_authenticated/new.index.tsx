import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";
import { GitBranch, Link2, ArrowRight, Layout } from "lucide-react";

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export const Route = createFileRoute("/_authenticated/new/")({
  component: NewProjectPage,
});

const GITHUB_APP_NAME = "creek-deploy"; // GitHub App slug

function NewProjectPage() {
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState("");
  const [urlError, setUrlError] = useState("");

  function handleUrlImport() {
    if (!repoUrl.trim()) {
      setUrlError("Please enter a repository URL");
      return;
    }
    // Basic URL validation
    try {
      const url = new URL(repoUrl);
      if (!["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname)) {
        setUrlError("Only GitHub, GitLab, and Bitbucket URLs are supported");
        return;
      }
    } catch {
      setUrlError("Please enter a valid URL");
      return;
    }
    setUrlError("");
    navigate({
      to: "/new/configure",
      search: { url: repoUrl, installation_id: undefined, owner: undefined, repo: undefined },
    });
  }

  function handleGitHubConnect() {
    // Open GitHub App installation page in new tab
    // After install, GitHub redirects to our setup URL
    window.open(
      `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`,
      "_blank",
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">New Project</h1>
        <p className="mt-1 text-muted-foreground">
          Import a Git repository or start from a template.
        </p>
      </div>

      {/* Section 1: URL Paste */}
      <div className="mb-8">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-10"
              placeholder="Enter a Git repository URL to deploy..."
              value={repoUrl}
              onChange={(e) => {
                setRepoUrl(e.target.value);
                setUrlError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && handleUrlImport()}
            />
          </div>
          <Button onClick={handleUrlImport} disabled={!repoUrl.trim()}>
            Import <ArrowRight className="ml-1 size-4" />
          </Button>
        </div>
        {urlError && (
          <p className="mt-1 text-sm text-destructive">{urlError}</p>
        )}
      </div>

      <div className="relative mb-8">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">or</span>
        </div>
      </div>

      {/* Section 2 + 3: Import Git + Templates */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Import Git Repository */}
        <div className="rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Import Git Repository</h2>
          <div className="space-y-3">
            <Button
              variant="outline"
              className="w-full justify-start gap-3"
              onClick={handleGitHubConnect}
            >
              <GithubIcon className="size-5" />
              Continue with GitHub
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start gap-3 opacity-50"
              disabled
            >
              <GitBranch className="size-5" />
              Continue with GitLab
              <span className="ml-auto text-xs text-muted-foreground">Soon</span>
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start gap-3 opacity-50"
              disabled
            >
              <GitBranch className="size-5" />
              Continue with Bitbucket
              <span className="ml-auto text-xs text-muted-foreground">Soon</span>
            </Button>
          </div>
        </div>

        {/* Clone Template */}
        <div className="rounded-lg border p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Clone Template</h2>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { name: "Vite + React", desc: "SPA starter" },
              { name: "Hono API", desc: "Workers API" },
              { name: "Astro Blog", desc: "Static blog" },
              { name: "Nuxt SaaS", desc: "Full-stack app" },
            ].map((t) => (
              <button
                key={t.name}
                className="rounded-md border p-3 text-left transition-colors hover:bg-accent"
                onClick={() => {
                  // TODO: Phase 7 template flow
                }}
              >
                <div className="mb-1 flex items-center gap-2">
                  <Layout className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{t.name}</span>
                </div>
                <span className="text-xs text-muted-foreground">{t.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
