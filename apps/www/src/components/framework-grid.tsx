"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";

const frameworks = [
  { name: "Next.js", config: 'framework = "next"' },
  { name: "TanStack Start", config: 'framework = "tanstack-start"' },
  { name: "Nuxt", config: 'framework = "nuxt"' },
  { name: "Remix", config: 'framework = "remix"' },
  { name: "SvelteKit", config: 'framework = "sveltekit"' },
  { name: "Astro", config: 'framework = "astro"' },
  { name: "Vite", config: 'framework = "vite"' },
  { name: "Hono", config: 'framework = "hono"' },
];

export function FrameworkGrid() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <div ref={ref} className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full">
      {frameworks.map((fw, i) => (
        <motion.div
          key={fw.name}
          initial={{ opacity: 0, y: 16 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: i * 0.08, duration: 0.4, ease: "easeOut" }}
          className="group relative rounded-xl border border-border bg-code-bg p-4 hover:border-accent/30 hover:bg-accent/[0.03] transition-colors cursor-default"
        >
          <p className="text-sm font-medium mb-1">{fw.name}</p>
          <p className="font-mono text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            {fw.config}
          </p>
          {/* Glow on hover */}
          <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none bg-[radial-gradient(circle_at_50%_50%,oklch(0.75_0.15_200_/_0.06),transparent_70%)]" />
        </motion.div>
      ))}
    </div>
  );
}
