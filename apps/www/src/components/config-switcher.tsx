"use client";

import { useState, useRef } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";

const configs = [
  {
    name: "Next.js",
    toml: `[project]
name = "my-app"
framework = "next"

[build]
command = "npm run build"`,
    output: `$ creek deploy
  Detected: Next.js 16
  Building with next build...
  Bundling SSR worker
  Uploading 34 assets
  Deployed to https://my-app-acme.bycreek.com`,
  },
  {
    name: "TanStack Start",
    toml: `[project]
name = "my-app"
framework = "tanstack-start"

[build]
command = "npm run build"`,
    output: `$ creek deploy
  Detected: TanStack Start
  Building with vinxi build...
  Bundling SSR worker
  Uploading 18 assets
  Deployed to https://my-app-acme.bycreek.com`,
  },
  {
    name: "Nuxt",
    toml: `[project]
name = "my-app"
framework = "nuxt"

[build]
command = "npm run build"`,
    output: `$ creek deploy
  Detected: Nuxt 4
  Building with nuxi build...
  Bundling Nitro worker
  Uploading 28 assets
  Deployed to https://my-app-acme.bycreek.com`,
  },
  {
    name: "Hono",
    toml: `[project]
name = "my-api"
framework = "hono"

[build]
command = "npm run build"`,
    output: `$ creek deploy
  Detected: Hono
  Building with esbuild...
  Bundling API worker
  Uploading 2 assets
  Deployed to https://my-api-acme.bycreek.com`,
  },
  {
    name: "Astro",
    toml: `[project]
name = "my-site"
framework = "astro"

[build]
command = "npm run build"`,
    output: `$ creek deploy
  Detected: Astro 5
  Building with astro build...
  Bundling SSR worker
  Uploading 42 assets
  Deployed to https://my-site-acme.bycreek.com`,
  },
  {
    name: "Vite",
    toml: `[project]
name = "my-spa"
framework = "vite"

[build]
command = "npm run build"
output = "dist"`,
    output: `$ creek deploy
  Detected: Vite (static)
  Building with vite build...
  Uploading 8 assets
  Deployed to https://my-spa-acme.bycreek.com`,
  },
];

export function ConfigSwitcher() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });
  const [active, setActive] = useState(0);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5 }}
      className="space-y-4"
    >
      {/* Framework tabs */}
      <div className="flex flex-wrap gap-2">
        {configs.map((c, i) => (
          <button
            key={c.name}
            onClick={() => setActive(i)}
            className={`rounded-lg px-3 py-1.5 text-xs font-mono transition-colors ${
              i === active
                ? "bg-accent/15 text-accent border border-accent/30"
                : "text-muted-foreground border border-border hover:border-accent/20 hover:text-foreground"
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>

      {/* Config + Output side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* creek.toml */}
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="flex items-center px-4 py-2.5 bg-code-bg border-b border-border">
            <span className="text-xs text-muted-foreground font-mono">creek.toml</span>
          </div>
          <div className="bg-code-bg p-5 min-h-[200px]">
            <AnimatePresence mode="wait">
              <motion.pre
                key={active}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2 }}
                className="font-mono text-[13px] leading-7 text-foreground/80 whitespace-pre"
              >
                {configs[active].toml}
              </motion.pre>
            </AnimatePresence>
          </div>
        </div>

        {/* Build output */}
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="flex items-center gap-1.5 px-4 py-2.5 bg-code-bg border-b border-border">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/60" />
            <span className="ml-3 text-xs text-muted-foreground font-mono">Terminal</span>
          </div>
          <div className="bg-code-bg p-5 min-h-[200px]">
            <AnimatePresence mode="wait">
              <motion.pre
                key={active}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, delay: 0.1 }}
                className="font-mono text-[13px] leading-7 whitespace-pre"
              >
                {configs[active].output.split("\n").map((line, i) => (
                  <div key={i} className={
                    line.startsWith("$") ? "text-foreground" :
                    line.includes("Deployed") ? "text-accent font-medium" :
                    "text-muted-foreground"
                  }>
                    {line}
                  </div>
                ))}
              </motion.pre>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
