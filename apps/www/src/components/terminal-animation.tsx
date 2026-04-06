"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { motion, useInView } from "framer-motion";

interface Line {
  text: string;
  className?: string;
  delay: number; // ms after animation start
}

const lines: Line[] = [
  { text: "$ creek deploy", className: "text-foreground", delay: 0 },
  { text: "  Detecting framework... Next.js", className: "text-muted-foreground", delay: 1200 },
  { text: "  Building...", className: "text-muted-foreground", delay: 1800 },
  { text: "  Build completed in 1.2s", className: "text-muted-foreground", delay: 2800 },
  { text: "  Uploading 24 assets to edge", className: "text-muted-foreground", delay: 3200 },
  { text: "  Deployed to 300+ locations", className: "text-accent", delay: 3800 },
  { text: "", className: "", delay: 4200 },
  { text: "  https://my-app-acme.bycreek.com", className: "text-accent font-medium", delay: 4200 },
];

export function TerminalAnimation({ onDeployStart }: { onDeployStart?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const [visibleLines, setVisibleLines] = useState<number>(0);
  const [typedText, setTypedText] = useState("");
  const startedRef = useRef(false);
  const onDeployStartRef = useRef(onDeployStart);
  onDeployStartRef.current = onDeployStart;

  useEffect(() => {
    if (!isInView || startedRef.current) return;
    startedRef.current = true;

    const fullCommand = "$ creek deploy";
    let charIndex = 0;

    // Typing effect for first line
    const typeInterval = setInterval(() => {
      charIndex++;
      setTypedText(fullCommand.slice(0, charIndex));
      if (charIndex >= fullCommand.length) {
        clearInterval(typeInterval);
        setVisibleLines(1);
      }
    }, 60);

    // Show subsequent lines with delays
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    lines.forEach((line, i) => {
      if (i === 0) return;
      const t = setTimeout(() => {
        setVisibleLines(i + 1);
        if (i === 5) onDeployStartRef.current?.();
      }, line.delay);
      timeouts.push(t);
    });

    return () => {
      clearInterval(typeInterval);
      timeouts.forEach(clearTimeout);
    };
  }, [isInView]);

  return (
    <div ref={ref} className="rounded-xl border border-border overflow-hidden w-full">
      {/* Title bar */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 bg-code-bg border-b border-border">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/60" />
        <span className="ml-3 text-xs text-muted-foreground font-mono">Terminal</span>
      </div>
      {/* Content */}
      <div className="bg-code-bg p-5 font-mono text-[13px] leading-7 min-h-[240px]">
        {/* Typing line — always render once typedText has content */}
        {typedText && (
          <div className="text-foreground">
            {typedText}
            {visibleLines === 0 && (
              <span className="inline-block w-[7px] h-[15px] bg-accent/80 ml-0.5 align-middle animate-pulse" />
            )}
          </div>
        )}
        {/* Subsequent lines */}
        {lines.slice(1).map((line, i) =>
          i + 1 < visibleLines ? (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className={line.className}
            >
              {line.text}
            </motion.div>
          ) : null,
        )}
      </div>
    </div>
  );
}
