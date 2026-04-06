"use client";

import { motion } from "framer-motion";
import { Footer } from "@/components/footer";

const entries = [
  {
    date: "2026-03-27",
    version: "0.3.0-alpha.14",
    title: "Query commands, MCP server, docs site",
    items: [
      "`creek projects` / `creek deployments` / `creek status` — query your projects and deployments",
      "Remote MCP server at mcp.creek.dev — AI agents can deploy with a single tool call",
      "Documentation site at creek.dev/docs (powered by fumadocs)",
      "Bin aliases: `ck` and `crk` as shortcuts for `creek`",
      "llms.txt for AI agent discovery",
      "Distribution strategy and 21+ planning documents",
    ],
  },
  {
    date: "2026-03-27",
    version: "0.3.0-alpha.12",
    title: "Rate limit improvements, agent-first output",
    items: [
      "Rate limit raised to 10/hr, demo deploys exempt",
      "429 responses include `hint` field guiding users to `creek login`",
      "Global `--json` and `--yes` flags on all 10 commands",
      "Non-TTY environments auto-enable JSON output",
      "Malformed JSON requests return 400 (not 500)",
    ],
  },
  {
    date: "2026-03-27",
    version: "0.3.0-alpha.9",
    title: "Sandbox UX redesign",
    items: [
      "`creek deploy --demo` — zero-dependency instant deploy",
      "`creek deploy ./dist` — deploy any directory",
      "Empty directory shows helpful guidance instead of scaffold prompt",
      "Build output auto-detection (dist/, build/, out/)",
      "Removed interactive scaffold flow — Creek is a deploy platform, not a boilerplate generator",
    ],
  },
  {
    date: "2026-03-27",
    version: "0.3.0-alpha.1",
    title: "First public release",
    items: [
      "CLI published to npm as `creek`",
      "@solcreek/sdk published",
      "Security audit: shell injection, config permissions, XSS, env redaction",
      "Apache 2.0 license",
    ],
  },
  {
    date: "2026-03-26",
    version: "Internal",
    title: "MVP + Sandbox + Production infrastructure",
    items: [
      "Phase 0-2.5 completed: platform stabilization, auth, dashboard, production deploy",
      "Sandbox system: deploy, status, claim, delete, content scanning, WAF",
      "Banner with Shadow DOM, QR code, RWD",
      "OpenTofu managing 43+ Cloudflare resources",
      "creek.dev and app.creek.dev deployed via Creek (dogfooding)",
    ],
  },
];

export default function ChangelogPage() {
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
            <a href="/changelog" className="text-foreground">Changelog</a>
            <a href="https://github.com/solcreek/creek" className="hover:text-foreground transition-colors" target="_blank" rel="noopener noreferrer">GitHub</a>
          </div>
        </div>
      </nav>

      {/* Header */}
      <section className="px-6 pt-20 pb-12 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-3xl font-semibold tracking-tight"
        >
          Changelog
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mt-3 text-muted-foreground"
        >
          What's new in Creek.
        </motion.p>
      </section>

      {/* Entries */}
      <section className="mx-auto max-w-2xl px-6 pb-28">
        <div className="space-y-12">
          {entries.map((entry, i) => (
            <motion.article
              key={entry.version}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.4 }}
            >
              <div className="flex items-center gap-3 mb-3">
                <time className="font-mono text-xs text-muted-foreground">{entry.date}</time>
                <span className="text-xs font-mono text-accent border border-accent/30 rounded-full px-2 py-0.5">
                  {entry.version}
                </span>
              </div>
              <h2 className="text-lg font-semibold tracking-tight mb-3">{entry.title}</h2>
              <ul className="space-y-1.5">
                {entry.items.map((item) => (
                  <li key={item} className="text-sm text-muted-foreground leading-relaxed flex gap-2">
                    <span className="text-accent mt-1.5 shrink-0">-</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </motion.article>
          ))}
        </div>
      </section>

      <Footer />
    </div>
  );
}
