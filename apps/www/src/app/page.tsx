"use client";

import { useState, useRef, useCallback, type MouseEvent } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";
import { CodeComparison } from "@/components/code-comparison";
import { Footer } from "@/components/footer";
import { PresenceBadge } from "@/components/presence-badge";

const DEMO_URL = "https://todo-demo.creek.dev";

export default function Home() {
  return (
    <div className="flex flex-col flex-1">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-lg">
        <div className="mx-auto max-w-5xl flex items-center justify-between px-6 h-14">
          <a href="/" className="font-mono text-sm font-medium tracking-tight">
            creek
          </a>
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <a href="/docs" className="hover:text-foreground transition-colors">Docs</a>
            <a href="/pricing" className="hover:text-foreground transition-colors">Pricing</a>
            <a href="https://templates.creek.dev" className="hover:text-foreground transition-colors">Templates</a>
            <a href="/changelog" className="hover:text-foreground transition-colors">Changelog</a>
            <a href="https://github.com/solcreek/creek" className="hover:text-foreground transition-colors" target="_blank" rel="noopener noreferrer">GitHub</a>
          </div>
        </div>
      </nav>

      {/* Hero: Title + Live Demo */}
      <section className="mx-auto w-full max-w-5xl px-6 pt-20 pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          {/* Left: Text */}
          <div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="font-mono text-xs text-muted-foreground mb-5 tracking-wide flex items-center gap-2 flex-wrap"
            >
              <a
                href="https://github.com/solcreek/creek"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                title="View source on GitHub"
              >
                <span className="size-1.5 rounded-full bg-accent" />
                Open-source
              </a>
              <span className="text-muted-foreground/40">·</span>
              <span>Apache 2.0</span>
              <span className="text-muted-foreground/40">·</span>
              <a
                href="/docs/self-hosting"
                className="hover:text-foreground transition-colors"
              >
                Self-hostable
              </a>
            </motion.div>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="text-4xl font-semibold leading-[1.15] tracking-tight sm:text-5xl"
            >
              Deploy to the edge.
              <br />
              <span className="bg-gradient-to-r from-accent via-[oklch(0.7_0.12_240)] to-accent bg-clip-text text-transparent">
                Realtime built in.
              </span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mt-5 text-muted-foreground leading-relaxed max-w-md"
            >
              One command or one GitHub push. SQLite, cron, queues, websockets,
              analytics — all built in. Powered by Cloudflare's network across
              300+ edge POPs.
            </motion.p>

            {/* Framework badges — answers "does this support my stack" in a
                single glance. Vite gets visual priority because (a) our
                Vite-based detection is our strongest zero-config tier and
                (b) we're intentionally planting a flag on the "vite deploy
                platform" search slot while void.cloud is still in early
                access. */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.28 }}
              className="mt-5 flex items-center gap-3 flex-wrap text-xs text-muted-foreground"
            >
              <span className="font-mono tracking-wide text-foreground">
                Vite-first
              </span>
              <span className="text-muted-foreground/40">—</span>
              <FrameworkBadges />
              <span className="text-muted-foreground/40">·</span>
              <span>zero config</span>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.35 }}
              className="mt-8 space-y-3"
            >
              <CopyCommand command="npx creek deploy" />
              <p className="text-sm text-muted-foreground">
                or{" "}
                <a
                  href="https://app.creek.dev/new"
                  className="text-foreground underline underline-offset-4 hover:text-accent transition-colors"
                >
                  import a repository directly from GitHub
                </a>{" "}
                — push to main, auto-deploy, preview URLs on every PR.
              </p>
              <p className="text-xs text-muted-foreground/80">
                Free to start.{" "}
                <a
                  href="/pricing"
                  className="underline underline-offset-4 hover:text-foreground transition-colors"
                >
                  See pricing
                </a>{" "}
                ·{" "}
                <a
                  href="https://github.com/solcreek/creek"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 hover:text-foreground transition-colors"
                >
                  Star on GitHub
                </a>
              </p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.6 }}
              className="mt-6"
            >
              <PresenceBadge />
            </motion.div>
          </div>

          {/* Right: Live Demo */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.3 }}
          >
            <HeroDemo />
          </motion.div>
        </div>
      </section>

      {/* Section: Realtime in 6 lines */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="01"
          title="Realtime in 6 lines"
          description="WebSocket sync, optimistic updates, multi-user rooms. Zero boilerplate."
        />
        <CodeComparison />
      </section>

      {/* Section: Your repo is the config */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="02"
          title="Your repo is the config"
          description="creek.toml is optional. Creek reads your framework config, package.json, wrangler files — or just an index.html — and works it out. Framework, bindings, build command, output dir: inferred from what's already in your repo. Add a creek.toml only when you need triggers or explicit overrides."
        />
        <ZeroConfigDemo />
      </section>

      {/* Section: Agent-First */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="03"
          title="Built for AI agents"
          description="Remote MCP server, JSON output on every command, installable agent skills, and the Agent Challenge protocol so verified agents skip CAPTCHAs. All shipping today."
        />
        <AgentFirstDemo />
      </section>

      {/* Section: Edge Performance */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="04"
          title="Edge-native performance"
          description="Your app runs on 300+ Cloudflare edge locations. Millisecond cold starts, global TTFB."
        />
        <PerformanceComparison />
      </section>

      {/* Section: Open Source */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="05"
          title="Open source"
          description="Apache 2.0 licensed. Self-host on your own Cloudflare account. No vendor lock-in."
        />
        <OpenSourceSection />
      </section>

      {/* Feature grid */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <FeatureGrid />
      </section>

      {/* CTA */}
      <section className="border-t border-border py-20 text-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <div className="mx-auto max-w-md flex justify-center">
            <CopyCommand command="npx creek deploy" />
          </div>
          <h2 className="mt-8 text-2xl font-semibold tracking-tight">
            Deploy in 10 seconds
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            No account needed. Try it right now.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <a
              href="/docs/getting-started"
              className="rounded-lg bg-foreground text-background px-5 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Read the docs
            </a>
            <a
              href="/pricing"
              className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
            >
              View pricing
            </a>
          </div>
        </motion.div>
      </section>

      <Footer />
    </div>
  );
}

/* ─── Hero Demo (inline — compact version for hero) ─── */

function HeroDemo() {
  const [roomId] = useState(() => crypto.randomUUID().slice(0, 8));
  const iframeSrc = `${DEMO_URL}/?room=${roomId}`;

  return (
    <div className="rounded-xl border border-border overflow-hidden bg-[oklch(0.1_0_0)]">
      <div style={{ height: 380 }}>
        <iframe
          src={iframeSrc}
          className="w-full h-full border-0"
          loading="lazy"
          allow="clipboard-write"
        />
      </div>
    </div>
  );
}

/* ─── Sub-components ─── */

function SectionHeader({ label, title, description }: { label: string; title: string; description: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div ref={ref} initial={{ opacity: 0, y: 20 }} animate={isInView ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.5 }} className="mb-8">
      <p className="font-mono text-xs text-muted-foreground mb-3">{label}</p>
      <h2 className="text-2xl font-semibold tracking-tight mb-2">{title}</h2>
      <p className="text-muted-foreground leading-relaxed max-w-lg">{description}</p>
    </motion.div>
  );
}

function ZeroConfigDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  const frameworks = [
    { name: "React (Vite)", detect: "vite-react", output: "dist/", time: "8.3s" },
    { name: "Vue (Vite)", detect: "vite-vue", output: "dist/", time: "7.9s" },
    { name: "Svelte (Vite)", detect: "vite-svelte", output: "dist/", time: "6.4s" },
    { name: "Astro", detect: "astro", output: "dist/", time: "6.7s" },
  ];

  return (
    <div ref={ref} className="grid gap-3 sm:grid-cols-2">
      {frameworks.map((fw, i) => (
        <motion.div
          key={fw.name}
          initial={{ opacity: 0, y: 12 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: i * 0.08, duration: 0.4 }}
          className="rounded-xl border border-border bg-code-bg p-5"
        >
          <p className="text-sm font-medium mb-3">{fw.name}</p>
          <div className="font-mono text-[12px] leading-6 text-muted-foreground space-y-0.5">
            <p><span className="text-muted-foreground/50">$ </span><span className="text-foreground">creek deploy</span></p>
            <p className="text-accent">  Detected: {fw.detect}</p>
            <p>  Building...</p>
            <p>  Output: {fw.output}</p>
            <p className="text-green-400">  Live in {fw.time} →</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function AgentFirstDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5 }}
      className="grid gap-4 lg:grid-cols-2"
    >
      {/* MCP Config */}
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-2.5 bg-code-bg border-b border-border flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/60" />
          <span className="ml-3 text-xs text-muted-foreground font-mono">MCP Config</span>
        </div>
        <div className="bg-code-bg p-5 font-mono text-[13px] leading-7">
          <pre className="text-muted-foreground whitespace-pre">{`{
  "mcpServers": {
    "creek": {
      "url": "https://mcp.creek.dev/mcp"
    }
  }
}`}</pre>
          <p className="mt-4 text-xs text-muted-foreground/70">
            Add one line. Any AI agent can deploy. No CAPTCHAs — verified via{" "}
            <a href="/docs/api#agent-challenge" className="underline hover:text-accent transition-colors">
              Agent Challenge
            </a>
            .
          </p>
        </div>
      </div>

      {/* JSON Output */}
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-2.5 bg-code-bg border-b border-border flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/60" />
          <span className="ml-3 text-xs text-muted-foreground font-mono">creek deploy --json</span>
        </div>
        <div className="bg-code-bg p-5 font-mono text-[13px] leading-7">
          <pre className="text-muted-foreground whitespace-pre">{`{
  "ok": true,
  "url": "https://a1b2.creeksandbox.com",
  "deployDurationMs": 9234,
  "mode": "sandbox"
}`}</pre>
          <p className="mt-4 text-xs text-muted-foreground/70">
            Structured output. No parsing needed.
          </p>
        </div>
      </div>

      {/* Agent Skills — span both columns on lg */}
      <div className="rounded-xl border border-border overflow-hidden lg:col-span-2">
        <div className="px-4 py-2.5 bg-code-bg border-b border-border flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/60" />
          <span className="ml-3 text-xs text-muted-foreground font-mono">Agent Skills</span>
        </div>
        <div className="bg-code-bg p-5 font-mono text-[13px] leading-7 grid gap-4 sm:grid-cols-[1fr_1fr]">
          <div>
            <pre className="text-foreground whitespace-pre">{`$ npx skills add solcreek/skills`}</pre>
            <pre className="mt-3 text-muted-foreground whitespace-pre text-[12px]">{`# Installs the "creek" skill into
# Claude Code, Cursor, Copilot,
# Gemini CLI, OpenCode, …`}</pre>
          </div>
          <div>
            <p className="text-[13px] text-muted-foreground leading-6">
              Agents get the full CLI reference, deployment modes, trigger
              schema, and troubleshooting tree — loaded on demand via the{" "}
              <a
                href="https://agentskills.io"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-accent transition-colors"
              >
                open Agent Skills standard
              </a>
              .
            </p>
            <p className="mt-3 text-[11px] text-muted-foreground/60">
              Apache 2.0 · maintained at{" "}
              <a
                href="https://github.com/solcreek/skills"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-accent/80 transition-colors"
              >
                solcreek/skills
              </a>
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function PerformanceComparison() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  const regions = [
    { name: "Tokyo", creek: 12, traditional: 280 },
    { name: "Frankfurt", creek: 18, traditional: 45 },
    { name: "Sao Paulo", creek: 25, traditional: 350 },
    { name: "Sydney", creek: 15, traditional: 310 },
    { name: "US East", creek: 8, traditional: 22 },
  ];

  return (
    <div ref={ref} className="rounded-xl border border-border overflow-hidden">
      <div className="grid grid-cols-[1fr_100px_100px] sm:grid-cols-[1fr_140px_140px] gap-4 px-6 py-3 bg-code-bg border-b border-border font-mono text-[11px] text-muted-foreground">
        <span>Region</span>
        <span className="text-right">Creek (edge)</span>
        <span className="text-right">Origin server</span>
      </div>
      {regions.map((region, i) => (
        <motion.div
          key={region.name}
          initial={{ opacity: 0, x: -12 }}
          animate={isInView ? { opacity: 1, x: 0 } : {}}
          transition={{ delay: i * 0.1, duration: 0.4 }}
          className="grid grid-cols-[1fr_100px_100px] sm:grid-cols-[1fr_140px_140px] gap-4 px-6 py-3 border-b border-border last:border-0 items-center"
        >
          <span className="text-sm font-medium">{region.name}</span>
          <div className="text-right">
            <span className="font-mono text-sm text-accent">{region.creek}ms</span>
            <div className="mt-1 h-1 rounded-full bg-accent/20 overflow-hidden flex justify-end">
              <motion.div
                className="h-full rounded-full bg-accent"
                initial={{ width: 0 }}
                animate={isInView ? { width: `${Math.max((region.creek / 50) * 100, 10)}%` } : {}}
                transition={{ delay: i * 0.1 + 0.3, duration: 0.6, ease: "easeOut" }}
              />
            </div>
          </div>
          <div className="text-right">
            <span className="font-mono text-sm text-muted-foreground">{region.traditional}ms</span>
            <div className="mt-1 h-1 rounded-full bg-muted-foreground/10 overflow-hidden flex justify-end">
              <motion.div
                className="h-full rounded-full bg-muted-foreground/30"
                initial={{ width: 0 }}
                animate={isInView ? { width: `${Math.min((region.traditional / 400) * 100, 100)}%` } : {}}
                transition={{ delay: i * 0.1 + 0.3, duration: 0.6, ease: "easeOut" }}
              />
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function OpenSourceSection() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  const items = [
    { title: "Apache 2.0", desc: "Use it, modify it, self-host it. No strings attached." },
    { title: "Self-hostable", desc: "Run Creek on your own Cloudflare account with a single command." },
    { title: "No lock-in", desc: "Standard build tools, standard output. Eject anytime." },
  ];

  return (
    <div ref={ref} className="grid gap-3 sm:grid-cols-3">
      {items.map((item, i) => (
        <motion.div
          key={item.title}
          initial={{ opacity: 0, y: 12 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: i * 0.08, duration: 0.4 }}
          className="rounded-xl border border-border p-6"
        >
          <h3 className="text-sm font-semibold mb-1.5">{item.title}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
        </motion.div>
      ))}
    </div>
  );
}

function FrameworkBadges() {
  // Only frameworks the landing page can actually back up on the docs
  // page. Vite leads because vite-based SPA detection is our most mature,
  // zero-config tier (vite-react, vite-vue, vite-svelte, vite-solid all
  // work out of the box). The meta-frameworks list is intentionally
  // honest — Next.js is omitted because that support is still going
  // through adapter-creek; we'll add it here when the adapter ships.
  const frameworks = [
    { name: "Vite", href: "/docs/getting-started", emphasized: true },
    { name: "React", href: "/docs/getting-started" },
    { name: "Vue", href: "/docs/getting-started" },
    { name: "Svelte", href: "/docs/getting-started" },
    { name: "Solid", href: "/docs/getting-started" },
    { name: "Astro", href: "/docs/getting-started" },
    { name: "Nuxt", href: "/docs/getting-started" },
  ];

  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      {frameworks.map((fw, i) => (
        <span key={fw.name} className="inline-flex items-center gap-2">
          <a
            href={fw.href}
            className={
              fw.emphasized
                ? "font-mono font-semibold text-foreground hover:text-accent transition-colors"
                : "font-mono hover:text-foreground transition-colors"
            }
          >
            {fw.name}
          </a>
          {i < frameworks.length - 1 && (
            <span className="text-muted-foreground/30">·</span>
          )}
        </span>
      ))}
    </span>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="group relative rounded-lg border border-border bg-code-bg px-4 py-2.5 font-mono text-sm text-muted-foreground cursor-pointer hover:border-accent/30 transition-colors flex items-center gap-3"
    >
      <span>
        <span className="text-muted-foreground/50">$ </span>
        <span className="text-foreground">{command}</span>
      </span>
      <span className="text-[11px] text-muted-foreground/50 group-hover:text-accent/60 transition-colors">
        {copied ? "Copied!" : "Copy"}
      </span>
    </button>
  );
}

function FeatureGrid() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  const features = [
    { title: "10-second deploys", description: "From CLI to live URL on Cloudflare's global edge." },
    { title: "GitHub auto-deploy", description: "Push to main. Preview URLs on every pull request. Commit status in the diff." },
    { title: "Realtime sync", description: "db.mutate() auto-broadcasts. useLiveQuery() auto-refetches." },
    { title: "Cron triggers", description: "Schedule background jobs in creek.toml. No extra services." },
    { title: "Queues", description: "Per-project queue, auto-provisioned. Producer + consumer wired up." },
    { title: "Per-tenant analytics", description: "Requests, errors, p50/p99 latency. Cron execution log." },
    { title: "Custom domains", description: "Automatic SSL. One CLI command to set up." },
    { title: "Environment variables", description: "Encrypted at rest, injected at runtime." },
    { title: "Framework detection", description: "React, Vue, Svelte, Astro, Solid — auto-detected." },
  ];

  return (
    <div ref={ref} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {features.map((f, i) => (
        <motion.div
          key={f.title}
          initial={{ opacity: 0, y: 16 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: i * 0.06, duration: 0.4 }}
          className="rounded-xl border border-border bg-code-bg p-6 hover:border-accent/20 transition-colors"
        >
          <h3 className="text-sm font-medium mb-1.5">{f.title}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
        </motion.div>
      ))}
    </div>
  );
}
