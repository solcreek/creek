"use client";

import { useState, useEffect, useRef } from "react";
import { useWebDeploy, type DeployStatus } from "../../lib/deploy";

function parseRepoFromUrl(searchParams: string): { owner: string; repo: string; full: string } | null {
  const params = new URLSearchParams(searchParams);
  const raw = params.get("repo");
  if (!raw) return null;

  const cleaned = raw
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "");

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1];
  return { owner, repo, full: `https://github.com/${owner}/${repo}` };
}

function parseTemplateFromUrl(searchParams: string): {
  template: string;
  data: Record<string, string>;
} | null {
  const params = new URLSearchParams(searchParams);
  const template = params.get("template");
  if (!template) return null;

  const data: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key !== "template") data[key] = value;
  });

  return { template, data };
}

function buildTemplateCommand(template: string, data: Record<string, string>): string {
  const hasData = Object.keys(data).length > 0;
  if (hasData) {
    return `npx creek deploy --template ${template} --data '${JSON.stringify(data)}'`;
  }
  return `npx creek deploy --template ${template}`;
}

const STATUS_LABELS: Record<DeployStatus, string> = {
  idle: "",
  building: "Building project...",
  deploying: "Deploying to edge...",
  active: "Live!",
  failed: "Deploy failed",
};

export default function NewPage() {
  const [mounted, setMounted] = useState(false);
  const [repoInfo, setRepoInfo] = useState<{ owner: string; repo: string; full: string } | null>(null);
  const [templateInfo, setTemplateInfo] = useState<{ template: string; data: Record<string, string> } | null>(null);
  const [copied, setCopied] = useState(false);
  const deployState = useWebDeploy();

  useEffect(() => {
    const search = window.location.search;
    const parsedRepo = parseRepoFromUrl(search);
    const parsedTemplate = parseTemplateFromUrl(search);
    setRepoInfo(parsedRepo);
    if (!parsedRepo) setTemplateInfo(parsedTemplate);
    setMounted(true);
  }, []);

  // SSR: show minimal loading shell. Client JS takes over after mount.
  if (!mounted) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] flex flex-col">
        <nav className="border-b border-[#222] bg-[#0a0a0a]/80 backdrop-blur-lg">
          <div className="mx-auto max-w-2xl flex items-center justify-between px-6 h-14">
            <a href="/" className="font-mono text-sm font-medium tracking-tight">creek</a>
            <div className="flex items-center gap-6 text-sm text-[#888]">
              <a href="/docs" className="hover:text-[#e5e5e5] transition-colors">Docs</a>
              <a href="/pricing" className="hover:text-[#e5e5e5] transition-colors">Pricing</a>
            </div>
          </div>
        </nav>
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="text-[#555] text-sm">Loading...</div>
        </main>
      </div>
    );
  }

  const command = repoInfo
    ? `npx creek deploy ${repoInfo.full}`
    : templateInfo
      ? buildTemplateCommand(templateInfo.template, templateInfo.data)
      : "npx creek deploy";

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDeploy = () => {
    if (repoInfo) {
      deployState.deploy({ type: "repo", repo: repoInfo.full });
    } else if (templateInfo) {
      deployState.deploy({
        type: "template",
        template: templateInfo.template,
        data: Object.keys(templateInfo.data).length > 0 ? templateInfo.data : undefined,
      });
    }
  };

  const isDeploying = deployState.status !== "idle";
  const canDeploy = (repoInfo || templateInfo) && !isDeploying;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] flex flex-col">
      {/* Nav */}
      <nav className="border-b border-[#222] bg-[#0a0a0a]/80 backdrop-blur-lg">
        <div className="mx-auto max-w-2xl flex items-center justify-between px-6 h-14">
          <a href="/" className="font-mono text-sm font-medium tracking-tight">creek</a>
          <div className="flex items-center gap-6 text-sm text-[#888]">
            <a href="/docs" className="hover:text-[#e5e5e5] transition-colors">Docs</a>
            <a href="/pricing" className="hover:text-[#e5e5e5] transition-colors">Pricing</a>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-lg w-full text-center">
          {/* Deploy in progress */}
          {isDeploying ? (
            <DeployProgress
              status={deployState.status}
              previewUrl={deployState.previewUrl}
              expiresAt={deployState.expiresAt}
              error={deployState.error}
              onReset={deployState.reset}
            />
          ) : repoInfo ? (
            <>
              <div className="mb-6">
                <p className="text-xs font-mono text-[#888] mb-2">Deploy to Creek</p>
                <h1 className="text-2xl font-semibold tracking-tight">
                  {repoInfo.owner}/{repoInfo.repo}
                </h1>
              </div>

              <a
                href={repoInfo.full}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-sm text-[#888] hover:text-[#60d0e0] transition-colors mb-8"
              >
                View on GitHub →
              </a>

              <DeployActions
                command={command}
                copied={copied}
                onCopy={handleCopy}
                onDeploy={handleDeploy}
                canDeploy={!!canDeploy}
              />
            </>
          ) : templateInfo ? (
            <>
              <div className="mb-6">
                <p className="text-xs font-mono text-[#888] mb-2">Deploy template</p>
                <h1 className="text-2xl font-semibold tracking-tight">{templateInfo.template}</h1>
              </div>

              {Object.keys(templateInfo.data).length > 0 && (
                <div className="rounded-xl border border-[#222] bg-[#111] p-4 text-left mb-6">
                  <p className="text-xs text-[#888] font-mono mb-2">Custom parameters:</p>
                  <div className="space-y-1">
                    {Object.entries(templateInfo.data).map(([key, value]) => (
                      <div key={key} className="flex items-center gap-2 text-sm font-mono">
                        <span className="text-[#888]">{key}:</span>
                        <span className="text-[#e5e5e5]">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <DeployActions
                command={command}
                copied={copied}
                onCopy={handleCopy}
                onDeploy={handleDeploy}
                canDeploy={!!canDeploy}
              />
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight mb-4">Deploy to Creek</h1>
              <p className="text-[#888] mb-8">Deploy any GitHub repository to the edge in seconds.</p>
              <CommandCard command={command} copied={copied} onCopy={handleCopy} />
              <p className="mt-4 text-xs text-[#555]">
                Or add a deploy button to your README —{" "}
                <a href="/docs/cli#deploy-to-creek-button" className="text-[#60d0e0]/60 hover:text-[#60d0e0]">
                  see docs
                </a>
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// --- Components ---

function DeployActions({
  command,
  copied,
  onCopy,
  onDeploy,
  canDeploy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
  onDeploy: () => void;
  canDeploy: boolean;
}) {
  return (
    <div className="space-y-4">
      {/* Deploy button */}
      <button
        onClick={onDeploy}
        disabled={!canDeploy}
        className="w-full py-3 px-6 rounded-xl bg-[#38bdf8] text-[#0a0a0a] font-semibold text-sm hover:bg-[#60d0e0] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Deploy to Creek
      </button>

      {/* CLI command */}
      <CommandCard command={command} copied={copied} onCopy={onCopy} />

      <p className="text-xs text-[#555]">
        No account needed — deploys to a 60-minute preview.{" "}
        <a href="https://app.creek.dev" className="text-[#60d0e0]/60 hover:text-[#60d0e0]">Sign up</a>
        {" "}for permanent deployments.
      </p>
    </div>
  );
}

// --- Simulated build/deploy sub-steps ---

const BUILD_STEPS = [
  { label: "Pulling template from registry", delay: 0 },
  { label: "Resolving dependencies", delay: 3 },
  { label: "Installing packages", delay: 6 },
  { label: "Detecting framework", delay: 18 },
  { label: "Compiling TypeScript", delay: 20 },
  { label: "Bundling for production", delay: 25 },
  { label: "Collecting assets", delay: 50 },
  { label: "Optimizing bundle", delay: 55 },
];

const DEPLOY_STEPS = [
  { label: "Hashing assets", delay: 0 },
  { label: "Uploading to 300+ edge locations", delay: 2 },
  { label: "Configuring Workers runtime", delay: 6 },
  { label: "Provisioning SSL certificate", delay: 9 },
  { label: "Propagating edge cache rules", delay: 12 },
  { label: "Activating Workers", delay: 15 },
  { label: "Running health checks", delay: 18 },
];

function useElapsedSeconds(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (running) {
      startRef.current = Date.now();
      const interval = setInterval(() => {
        setElapsed(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000));
      }, 1000);
      return () => clearInterval(interval);
    }
    startRef.current = null;
  }, [running]);

  return elapsed;
}

function useSimulatedSteps(steps: typeof BUILD_STEPS, active: boolean) {
  const elapsed = useElapsedSeconds(active);
  return steps.map((step) => ({
    label: step.label,
    state: !active
      ? ("done" as const)
      : elapsed >= step.delay + 3
        ? ("done" as const)
        : elapsed >= step.delay
          ? ("active" as const)
          : ("pending" as const),
  }));
}

function DeployProgress({
  status,
  previewUrl,
  expiresAt,
  error,
  onReset,
}: {
  status: DeployStatus;
  previewUrl: string | null;
  expiresAt: string | null;
  error: string | null;
  onReset: () => void;
}) {
  const isBuilding = status === "building";
  const isDeploying = status === "deploying";
  const buildElapsed = useElapsedSeconds(isBuilding);
  const deployElapsed = useElapsedSeconds(isDeploying);

  const buildSteps = useSimulatedSteps(BUILD_STEPS, isBuilding);
  const deploySteps = useSimulatedSteps(DEPLOY_STEPS, isDeploying);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-mono text-[#888] mb-2">Deploy to Creek</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {status === "active" ? "Deployed!" : status === "failed" ? "Deploy Failed" : "Deploying..."}
        </h1>
      </div>

      {/* Build phase */}
      <div className="rounded-xl border border-[#222] bg-[#111] p-5 text-left">
        <div className={`flex items-center justify-between ${isBuilding ? "mb-3" : ""}`}>
          <div className="flex items-center gap-2">
            <StepIcon state={isBuilding ? "active" : status === "failed" && error?.includes("build") ? "failed" : isBuilding ? "active" : "done"} />
            <span className="text-sm font-medium text-[#e5e5e5]">Building project</span>
          </div>
          {isBuilding && (
            <span className="text-xs font-mono text-[#555]">{buildElapsed}s</span>
          )}
        </div>

        {isBuilding && (
          <div className="ml-7 space-y-1.5">
            {buildSteps.map((step) => (
              <SubStep key={step.label} label={step.label} state={step.state} />
            ))}
          </div>
        )}
      </div>

      {/* Deploy phase */}
      <div className={`rounded-xl border p-5 text-left transition-colors ${
        isDeploying || status === "active" ? "border-[#222] bg-[#111]" : "border-[#1a1a1a] bg-[#0d0d0d]"
      }`}>
        <div className={`flex items-center justify-between ${isDeploying ? "mb-3" : ""}`}>
          <div className="flex items-center gap-2">
            <StepIcon state={
              isBuilding ? "pending"
                : isDeploying ? "active"
                  : status === "failed" && !error?.includes("build") ? "failed"
                    : status === "active" ? "done"
                      : "pending"
            } />
            <span className={`text-sm font-medium ${isBuilding ? "text-[#555]" : "text-[#e5e5e5]"}`}>
              Deploying to edge
            </span>
          </div>
          {isDeploying && (
            <span className="text-xs font-mono text-[#555]">{deployElapsed}s</span>
          )}
        </div>

        {isDeploying && (
          <div className="ml-7 space-y-1.5">
            {deploySteps.map((step) => (
              <SubStep key={step.label} label={step.label} state={step.state} />
            ))}
          </div>
        )}
      </div>

      {/* Live indicator */}
      <div className={`rounded-xl border p-5 text-left transition-colors ${
        status === "active" ? "border-[#38bdf8]/30 bg-[#38bdf8]/5" : "border-[#1a1a1a] bg-[#0d0d0d]"
      }`}>
        <div className="flex items-center gap-2">
          <StepIcon state={status === "active" ? "done" : status === "failed" ? "failed" : "pending"} />
          <span className={`text-sm font-medium ${status === "active" ? "text-[#38bdf8]" : "text-[#555]"}`}>
            Live
          </span>
        </div>
      </div>

      {/* Error — rate limit → signup CTA */}
      {status === "failed" && error && (
        error === "rate_limited" || error.includes("3 free deploys") ? (
          <div className="p-4 rounded-lg border border-[#38bdf8]/20 bg-[#38bdf8]/5 text-center space-y-3">
            <p className="text-sm text-[#e5e5e5]">You've used all 3 free deploys this hour.</p>
            <a
              href="https://app.creek.dev"
              className="inline-block py-2 px-5 rounded-lg bg-[#38bdf8] text-[#0a0a0a] font-semibold text-sm hover:bg-[#60d0e0] transition-colors"
            >
              Sign up for more deploys
            </a>
            <p className="text-xs text-[#555]">Or try again in an hour.</p>
          </div>
        ) : (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <p className="text-xs text-red-400 font-mono">{error}</p>
          </div>
        )
      )}

      {/* Success: preview URL */}
      {status === "active" && previewUrl && (
        <div className="space-y-3">
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full py-3 px-6 rounded-xl bg-[#38bdf8] text-[#0a0a0a] font-semibold text-sm text-center hover:bg-[#60d0e0] transition-colors"
          >
            Open Preview →
          </a>
          <p className="text-xs text-[#555] text-center">
            Preview expires {expiresAt ? `at ${new Date(expiresAt).toLocaleTimeString()}` : "in 60 minutes"}.{" "}
            <a href="https://app.creek.dev" className="text-[#60d0e0]/60 hover:text-[#60d0e0]">
              Sign up
            </a>{" "}
            to keep it permanently.
          </p>
        </div>
      )}

      {/* Footer */}
      {(isBuilding || isDeploying) && (
        <p className="text-center text-[10px] font-mono text-[#333]">
          ☁ creek deploy · Cloudflare Workers
        </p>
      )}

      {/* Reset */}
      {(status === "active" || status === "failed") && (
        <button
          onClick={onReset}
          className="text-xs text-[#555] hover:text-[#888] transition-colors"
        >
          ← Deploy another
        </button>
      )}
    </div>
  );
}

function StepIcon({ state }: { state: "pending" | "active" | "done" | "failed" }) {
  return (
    <div className="w-4 h-4 flex items-center justify-center">
      {state === "pending" && <div className="w-1.5 h-1.5 rounded-full bg-[#333]" />}
      {state === "active" && <div className="w-1.5 h-1.5 rounded-full bg-[#38bdf8] animate-pulse" />}
      {state === "done" && <span className="text-[#38bdf8] text-[10px]">✓</span>}
      {state === "failed" && <span className="text-red-400 text-[10px]">✗</span>}
    </div>
  );
}

function SubStep({ label, state }: { label: string; state: "pending" | "active" | "done" }) {
  return (
    <div className="flex items-center gap-2 h-5">
      <div className="w-3 h-3 flex items-center justify-center">
        {state === "pending" && <div className="w-1 h-1 rounded-full bg-[#2a2a2a]" />}
        {state === "active" && <div className="w-1 h-1 rounded-full bg-[#38bdf8] animate-pulse" />}
        {state === "done" && <span className="text-[#38bdf8] text-[8px]">✓</span>}
      </div>
      <span className={`text-xs font-mono ${
        state === "pending" ? "text-[#2a2a2a]" : state === "active" ? "text-[#888]" : "text-[#555]"
      }`}>
        {label}
      </span>
    </div>
  );
}

function CommandCard({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-xl border border-[#222] bg-[#111] p-4">
      <p className="text-xs text-[#888] font-mono mb-2">Or deploy via CLI:</p>
      <button
        onClick={onCopy}
        className="w-full group flex items-center justify-between rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-4 py-3 font-mono text-sm text-[#888] cursor-pointer hover:border-[#60d0e0]/30 transition-colors"
      >
        <span className="truncate text-left">
          <span className="text-[#555]">$ </span>
          <span className="text-[#e5e5e5]">{command}</span>
        </span>
        <span className="text-xs text-[#555] group-hover:text-[#60d0e0]/60 transition-colors ml-3 shrink-0">
          {copied ? "Copied!" : "Copy"}
        </span>
      </button>
    </div>
  );
}
