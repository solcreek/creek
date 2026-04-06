"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";

const creekConfig = `[project]
name = "my-app"
framework = "next"

[build]
command = "npm run build"`;

const otherConfigs = [
  {
    file: "vercel.json",
    lines: 12,
    content: `{
  "buildCommand": "npm run build",
  "outputDirectory": ".next",
  "framework": "nextjs",
  "regions": ["iad1"],
  "env": { ... },
  ...
}`,
  },
  {
    file: "wrangler.toml",
    lines: 18,
    content: `name = "my-app"
main = "worker/index.ts"
compatibility_date = "2024-01-01"

[site]
bucket = ".next/static"

[build]
command = "npm run build"
...`,
  },
  {
    file: ".github/workflows/deploy.yml",
    lines: 35,
    content: `name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      ...`,
  },
];

export function ConfigComparison() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5 }}
    >
      <div className="text-center mb-8">
        <p className="font-mono text-xs text-muted-foreground mb-3">SIMPLICITY</p>
        <h2 className="text-2xl font-semibold tracking-tight mb-2">Less config, more shipping</h2>
        <p className="text-muted-foreground leading-relaxed max-w-lg mx-auto">
          One file. Six lines. That&apos;s your entire deployment config.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Creek side */}
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          animate={isInView ? { opacity: 1, x: 0 } : {}}
          transition={{ delay: 0.2, duration: 0.4 }}
          className="rounded-xl border border-accent/30 overflow-hidden relative"
        >
          <div className="flex items-center justify-between px-4 py-2.5 bg-code-bg border-b border-accent/20">
            <span className="text-xs text-accent font-mono">creek.toml</span>
            <span className="text-[10px] font-mono text-accent/70">6 lines</span>
          </div>
          <pre className="bg-code-bg p-5 font-mono text-[13px] leading-7 text-foreground/80 whitespace-pre">
            {creekConfig}
          </pre>
          {/* Accent glow */}
          <div className="absolute inset-0 rounded-xl pointer-events-none bg-[radial-gradient(ellipse_at_center,oklch(0.75_0.15_200_/_0.04),transparent_70%)]" />
        </motion.div>

        {/* Others side */}
        <motion.div
          initial={{ opacity: 0, x: 12 }}
          animate={isInView ? { opacity: 1, x: 0 } : {}}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="space-y-2"
        >
          {otherConfigs.map((config, i) => (
            <motion.div
              key={config.file}
              initial={{ opacity: 0, y: 8 }}
              animate={isInView ? { opacity: 0.5, y: 0 } : {}}
              transition={{ delay: 0.4 + i * 0.1, duration: 0.3 }}
              className="rounded-xl border border-border overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-2 bg-code-bg border-b border-border">
                <span className="text-xs text-muted-foreground font-mono">{config.file}</span>
                <span className="text-[10px] font-mono text-muted-foreground/50">{config.lines} lines</span>
              </div>
              <pre className="bg-code-bg px-5 py-3 font-mono text-[11px] leading-5 text-muted-foreground/60 whitespace-pre max-h-[80px] overflow-hidden relative">
                {config.content}
                <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-code-bg to-transparent" />
              </pre>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </motion.div>
  );
}
