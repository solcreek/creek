"use client";

import { useRef, useState, useEffect } from "react";
import { motion, useInView } from "framer-motion";

interface HeroDemoProps {
  /** Base URL of the deployed demo app */
  demoUrl?: string;
}

export function HeroDemo({ demoUrl = "https://todo-demo.creek.dev" }: HeroDemoProps) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const [roomId] = useState(() => crypto.randomUUID().slice(0, 8));

  const iframeSrc = `${demoUrl}/?room=${roomId}`;
  const shareUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/live/${roomId}`;
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6 }}
      className="mt-10"
    >
      {/* Browser chrome */}
      <div className="rounded-xl border border-border overflow-hidden bg-[oklch(0.1_0_0)]">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-[oklch(0.12_0_0)]">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-[oklch(0.35_0_0)]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[oklch(0.35_0_0)]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[oklch(0.35_0_0)]" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground">
              realtime-todos.creek.dev
            </span>
          </div>
          <button
            onClick={handleCopy}
            className="text-[10px] font-mono text-muted-foreground hover:text-accent transition-colors"
          >
            {copied ? "Copied!" : "Share session"}
          </button>
        </div>

        {/* iframe */}
        <div className="relative" style={{ height: 420 }}>
          <iframe
            src={iframeSrc}
            className="w-full h-full border-0"
            loading="lazy"
            allow="clipboard-write"
          />
        </div>
      </div>

      <p className="mt-3 text-center text-xs text-muted-foreground font-mono">
        This app is deployed on Creek. Share the link — changes sync in real time.
      </p>
    </motion.div>
  );
}
