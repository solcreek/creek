"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";

const testimonials = [
  {
    quote: "Went from zero to production on Cloudflare Workers in under 5 minutes. Creek just works.",
    author: "Early beta user",
    role: "Full-stack developer",
  },
  {
    quote: "Finally a deployment tool that treats edge SSR as a first-class citizen. No more hacking around Workers limitations.",
    author: "Early beta user",
    role: "Platform engineer",
  },
  {
    quote: "creek deploy is the new git push heroku main. Simple, fast, and it just deploys.",
    author: "Early beta user",
    role: "Indie hacker",
  },
];

export function SocialProof() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5 }}
      className="space-y-8"
    >
      {/* Header */}
      <div className="text-center">
        <p className="font-mono text-xs text-muted-foreground mb-3">EARLY ADOPTERS</p>
        <h2 className="text-2xl font-semibold tracking-tight">Developers are shipping</h2>
      </div>

      {/* Testimonials */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {testimonials.map((t, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 16 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: i * 0.1, duration: 0.4 }}
            className="rounded-xl border border-border bg-code-bg p-5 flex flex-col"
          >
            <p className="text-sm text-foreground/90 leading-relaxed flex-1">
              &ldquo;{t.quote}&rdquo;
            </p>
            <div className="mt-4 pt-3 border-t border-border">
              <p className="text-xs font-medium">{t.author}</p>
              <p className="text-xs text-muted-foreground">{t.role}</p>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Stats */}
      <div className="flex justify-center gap-8">
        <div className="text-center">
          <div className="text-2xl font-semibold font-mono">OSS</div>
          <div className="text-xs text-muted-foreground mt-1">Open source</div>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="text-center">
          <div className="text-2xl font-semibold font-mono">300+</div>
          <div className="text-xs text-muted-foreground mt-1">Edge locations</div>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="text-center">
          <div className="text-2xl font-semibold font-mono">&lt;15ms</div>
          <div className="text-xs text-muted-foreground mt-1">Avg. TTFB</div>
        </div>
      </div>
    </motion.div>
  );
}
