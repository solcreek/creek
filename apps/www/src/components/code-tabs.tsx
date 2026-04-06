"use client";

import { useState, useRef } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";

interface TabData {
  key: string;
  label: string;
  file: string;
  html: string;
  callout: string;
}

export function CodeTabs({ tabs }: { tabs: TabData[] }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const [activeIdx, setActiveIdx] = useState(0);

  const active = tabs[activeIdx];

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5 }}
    >
      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-3">
        {tabs.map((tab, i) => (
          <button
            key={tab.key}
            onClick={() => setActiveIdx(i)}
            className={`px-3 py-1.5 rounded-md text-xs font-mono transition-colors ${
              activeIdx === i
                ? "bg-accent/15 text-accent border border-accent/30"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground font-mono">
          {active.file}
        </span>
      </div>

      {/* Code block */}
      <div className="rounded-xl border border-border overflow-hidden [&_pre]:!bg-[oklch(0.13_0_0)] [&_pre]:p-5 [&_pre]:text-[13px] [&_pre]:leading-7 [&_pre]:overflow-x-auto [&_code]:!bg-transparent">
        <AnimatePresence mode="wait">
          <motion.div
            key={active.key}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            dangerouslySetInnerHTML={{ __html: active.html }}
          />
        </AnimatePresence>
      </div>

      {/* Callout */}
      <p className="mt-3 text-xs text-muted-foreground font-mono text-center">
        {active.callout}
      </p>
    </motion.div>
  );
}
