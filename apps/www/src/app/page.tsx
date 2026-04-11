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
                Apache 2.0
              </a>
              <span className="text-muted-foreground/40">·</span>
              <a
                href="/docs/self-hosting"
                className="hover:text-foreground transition-colors"
              >
                Self-hostable
              </a>
              <span className="text-muted-foreground/40">·</span>
              <a
                href="/docs/mcp"
                className="hover:text-foreground transition-colors"
              >
                MCP · agent-ready
              </a>
            </motion.div>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="text-4xl font-semibold leading-[1.15] tracking-tight sm:text-5xl"
            >
              {/* Line 1 is deliberately broken after "hand" so the wedge
                  clause ("or by agent") lands on its own line. Without the
                  forced break, the 30-char line wraps mid-phrase in the
                  narrow two-column hero and kills the beat. */}
              Ship apps by hand
              <br />
              or by agent.
              <br />
              {/* Line 2 stays one tier smaller than line 1 to preserve
                  the headline + qualifier rhythm — Line 1 is the action,
                  Line 2 is the positioning backup. */}
              <span className="block text-3xl sm:text-4xl bg-gradient-to-r from-accent via-[oklch(0.7_0.12_240)] to-accent bg-clip-text text-transparent">
                Open source. Full-stack.
              </span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="mt-5 text-muted-foreground leading-relaxed max-w-md"
            >
              <span className="text-foreground font-medium">
                Ship full-stack Vite apps in one command.
              </span>{" "}
              Creek provisions the database, cron, queues, and WebSockets.{" "}
              <span className="text-accent font-medium">$0 to start.</span>
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.35 }}
              className="mt-8 space-y-3"
            >
              <div>
                <CopyCommand command="npx creek deploy" />
                <p className="mt-1.5 font-mono text-xs text-muted-foreground/70 tracking-wide">
                  no signup · live in seconds
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                or{" "}
                <a
                  href="https://app.creek.dev/new"
                  className="text-foreground underline underline-offset-4 hover:text-accent transition-colors"
                >
                  import from GitHub
                </a>{" "}
                →
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

      {/* Section: Coming from Vercel or Netlify */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="03"
          title="Coming from Vercel or Netlify?"
          description="We grew up on those platforms. They taught us what great deploy DX looks like — git push, PR previews, framework detection, env vars in the dashboard. Creek keeps all of it. The bill is different. The license is different. Everything else should feel familiar."
        />
        <MigrationSection />
      </section>

      {/* Section: Frameworks */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="04"
          title="Your framework is supported"
          description="Vite, React, Vue, Svelte, Astro, TanStack Start, React Router, Hono, static sites — zero config. Next.js via our adapter (WIP). Every framework written up honestly below."
        />
        <FrameworksSection />
      </section>

      {/* Section: Agent-First */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="05"
          title="Built for AI agents"
          description="Remote MCP server, JSON output on every command, installable agent skills, and the Agent Challenge protocol so verified agents skip CAPTCHAs. All shipping today."
        />
        <AgentFirstDemo />
      </section>

      {/* Section: Edge Performance */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="06"
          title="Edge-native performance"
          description="Your app runs on 300+ edge locations. Millisecond cold starts, global TTFB."
        />
        <PerformanceComparison />
      </section>

      {/* Section: Open Source */}
      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <SectionHeader
          label="07"
          title="Open source, not lock-in-free"
          description="Apache 2.0. Self-host on your own Cloudflare account. We're honest: Creek is built on Cloudflare Workers, so you're ultimately locked to Cloudflare. The point is you're not locked to us — your code keeps working if you eject to raw wrangler, because Creek deploys standard CF primitives, not proprietary ones."
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
    { title: "Apache 2.0", desc: "Use it, modify it, self-host it. Full source on GitHub." },
    { title: "Self-hostable", desc: "Run Creek on your own Cloudflare account with a single command." },
    { title: "Eject anytime", desc: "Creek deploys standard Cloudflare primitives. Your code runs on raw wrangler too." },
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

function MigrationSection() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  // Intentionally warm tone — no dunking on competitors, just a clear
  // "here's what transfers, here's what changes" layout. Vercel / Netlify
  // taught the whole category what good DX looks like; we owe them the
  // respect of naming them without trashing them.
  const cards = [
    {
      label: "Same workflow",
      lines: [
        "`git push` deploys.",
        "PR previews on every pull request.",
        "Framework auto-detection.",
        "Env vars in the dashboard.",
      ],
      note: "Nothing new to learn. Your muscle memory transfers.",
    },
    {
      label: "Same frameworks",
      lines: [
        "Vite, Astro, SvelteKit, Nuxt.",
        "Every Vite meta-framework, auto-detected.",
        "Next.js via adapter-creek (WIP).",
        "Static sites with one index.html.",
      ],
      note: "See the Frameworks section below for the full maturity tiers.",
    },
    {
      label: "Different bill",
      lines: [
        "$0 when idle. Pay per request.",
        "No per-seat fees.",
        "No surprise invoices when traffic spikes.",
        "Apache 2.0: self-host on your own account anytime.",
      ],
      note: "The point of Creek. The cost shape is structurally different, not marginally different.",
    },
  ];

  return (
    <div ref={ref} className="grid gap-4 lg:grid-cols-3">
      {cards.map((card, i) => (
        <motion.div
          key={card.label}
          initial={{ opacity: 0, y: 16 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: i * 0.08, duration: 0.4 }}
          className="rounded-xl border border-border bg-code-bg p-6 hover:border-accent/20 transition-colors"
        >
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            {card.label}
          </h3>
          <ul className="mt-4 space-y-2">
            {card.lines.map((line, idx) => (
              <li
                key={idx}
                className="text-sm text-foreground/80 leading-relaxed"
                // The first line in each card uses backticks for code-ish
                // content; render them as <code> for a light visual anchor.
                dangerouslySetInnerHTML={{
                  __html: line.replace(
                    /`([^`]+)`/g,
                    '<code class="font-mono text-accent bg-accent/10 rounded px-1 py-0.5">$1</code>',
                  ),
                }}
              />
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground leading-relaxed border-t border-border pt-3">
            {card.note}
          </p>
        </motion.div>
      ))}
    </div>
  );
}

function FrameworksSection() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  // Three honest tiers mirroring getting-started.mdx and CAPABILITIES.md.
  // "Zero-config" is what resolveConfig was designed against first —
  // Vite-based SPAs + Astro (Vite under the hood) + TanStack Start.
  // "Supported" is the next tier: works, may need minor config, server
  // builds still stabilizing for the Vite meta-frameworks. "Work in
  // progress" is just Next.js, routed through adapter-creek.
  const tiers: Array<{
    label: string;
    tint: "accent" | "muted" | "dim";
    caption: string;
    frameworks: string[];
  }> = [
    {
      label: "Zero-config",
      tint: "accent",
      caption: "Detected from package.json + vite.config. Deploy with no flags.",
      frameworks: ["Vite + React", "Vite + Vue", "Vite + Svelte", "Vite + Solid", "Astro", "TanStack Start"],
    },
    {
      label: "Supported",
      tint: "muted",
      caption: "Works today. Server build for SvelteKit / Nuxt is experimental.",
      frameworks: ["SvelteKit", "Nuxt", "React Router (v7 / Remix)", "Hono", "Static site"],
    },
    {
      label: "Work in progress",
      tint: "dim",
      caption: "Routed through @solcreek/adapter-creek, currently via an OpenNextJS workaround.",
      frameworks: ["Next.js"],
    },
  ];

  const dotClass = (tint: "accent" | "muted" | "dim") =>
    tint === "accent"
      ? "bg-accent"
      : tint === "muted"
        ? "bg-muted-foreground/60"
        : "bg-muted-foreground/30";

  const borderClass = (tint: "accent" | "muted" | "dim") =>
    tint === "accent"
      ? "border-accent/30 hover:border-accent/50"
      : "border-border hover:border-accent/20";

  return (
    <div ref={ref} className="grid gap-4 lg:grid-cols-3">
      {tiers.map((tier, i) => (
        <motion.div
          key={tier.label}
          initial={{ opacity: 0, y: 16 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: i * 0.08, duration: 0.4 }}
          className={`rounded-xl border ${borderClass(tier.tint)} bg-code-bg p-6 transition-colors`}
        >
          <div className="flex items-center gap-2">
            <span className={`size-1.5 rounded-full ${dotClass(tier.tint)}`} />
            <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              {tier.label}
            </h3>
          </div>
          <ul className="mt-4 space-y-2">
            {tier.frameworks.map((name) => (
              <li
                key={name}
                className={
                  tier.tint === "accent"
                    ? "text-sm font-medium text-foreground"
                    : tier.tint === "muted"
                      ? "text-sm text-foreground/80"
                      : "text-sm text-muted-foreground"
                }
              >
                {name}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground leading-relaxed">
            {tier.caption}
          </p>
        </motion.div>
      ))}
    </div>
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
    { title: "10-second deploys", description: "From CLI to live URL on the global edge." },
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
