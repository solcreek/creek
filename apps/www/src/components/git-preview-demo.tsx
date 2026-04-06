"use client";

import { useEffect, useState, useRef } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";

type Step = "idle" | "editing" | "pushing" | "deploying" | "done";

const codeBefore = `export default function Hero() {
  return (
    <section className="hero">
      <h1>Welcome</h1>
      <p>Build something great.</p>
    </section>
  );
}`;

const codeAfter = `export default function Hero() {
  return (
    <section className="hero">
      <h1>Welcome to Creek</h1>
      <p>Deploy to the edge in seconds.</p>
    </section>
  );
}`;

const prodUrl = "my-app-acme.bycreek.com";
const previewUrl = "my-app-git-new-hero-acme.bycreek.com";

export function GitPreviewDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });
  const [step, setStep] = useState<Step>("idle");

  useEffect(() => {
    if (!isInView) return;

    const timers = [
      setTimeout(() => setStep("editing"), 600),
      setTimeout(() => setStep("pushing"), 2200),
      setTimeout(() => setStep("deploying"), 3400),
      setTimeout(() => setStep("done"), 4800),
    ];

    return () => timers.forEach(clearTimeout);
  }, [isInView]);

  const showNewCode = step !== "idle";
  const showPreviewUrl = step === "deploying" || step === "done";
  const showPreviewContent = step === "done";

  return (
    <div ref={ref} className="space-y-4 w-full">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Left: Code Editor */}
      <div className="rounded-xl border border-border overflow-hidden">
        {/* Editor title bar */}
        <div className="flex items-center px-4 py-2.5 bg-code-bg border-b border-border">
          <div className="flex items-center gap-1.5 mr-4">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/60" />
          </div>
          <span className="text-xs text-muted-foreground font-mono">hero.tsx</span>
        </div>

        {/* Code content */}
        <div className="bg-code-bg p-5 font-mono text-[13px] leading-7 min-h-[280px]">
          <pre className="whitespace-pre">
            {(showNewCode ? codeAfter : codeBefore).split("\n").map((line, i) => {
              const isChanged = showNewCode && (i === 3 || i === 4);
              return (
                <div key={i} className="relative">
                  {isChanged && (
                    <motion.div
                      className="absolute -left-5 -right-5 -top-px -bottom-px bg-accent/5 border-l-2 border-accent/40"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3 }}
                    />
                  )}
                  <span className={`relative ${isChanged ? "text-accent" : "text-foreground/80"}`}>
                    <span className="text-muted-foreground/40 select-none inline-block w-6 text-right mr-4">{i + 1}</span>
                    {colorize(line)}
                  </span>
                </div>
              );
            })}
          </pre>
        </div>

        {/* Git push bar */}
        <AnimatePresence>
          {(step === "pushing" || step === "deploying" || step === "done") && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="border-t border-border bg-code-bg overflow-hidden"
            >
              <div className="px-5 py-3 font-mono text-[12px]">
                <span className="text-muted-foreground">$ </span>
                <span className="text-foreground">git push origin feat/new-hero</span>
                {(step === "deploying" || step === "done") && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-accent mt-1"
                  >
                    Branch pushed. Creek deploying preview...
                  </motion.div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Right: Browser Preview */}
      <div className="rounded-xl border border-border overflow-hidden">
        {/* Browser chrome */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-code-bg border-b border-border">
          <div className="flex items-center gap-1.5 mr-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/60" />
          </div>
          {/* URL bar */}
          <div className="flex-1 rounded-md bg-background/50 border border-border px-3 py-1 font-mono text-[11px] text-muted-foreground overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.span
                key={showPreviewUrl ? "preview" : "prod"}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3 }}
                className="block"
              >
                {showPreviewUrl ? previewUrl : prodUrl}
              </motion.span>
            </AnimatePresence>
          </div>
        </div>

        {/* Preview content */}
        <div className="bg-code-bg min-h-[280px] flex items-center justify-center p-8 relative">
          {/* Simulated web page */}
          <div className="text-center">
            <AnimatePresence mode="wait">
              <motion.div
                key={showPreviewContent ? "new" : "old"}
                initial={{ opacity: 0, filter: "blur(4px)" }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: "blur(4px)" }}
                transition={{ duration: 0.4 }}
              >
                <h3 className="text-2xl font-semibold mb-2">
                  {showPreviewContent ? "Welcome to Creek" : "Welcome"}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {showPreviewContent ? "Deploy to the edge in seconds." : "Build something great."}
                </p>
              </motion.div>
            </AnimatePresence>

            {/* Deploy status badge */}
            <AnimatePresence>
              {step === "done" && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  className="mt-6 inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                  <span className="text-xs font-mono text-accent">Preview ready</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Loading overlay */}
          {step === "deploying" && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center"
            >
              <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono">
                <motion.div
                  className="h-4 w-4 border-2 border-accent/30 border-t-accent rounded-full"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                />
                Deploying...
              </div>
            </motion.div>
          )}
        </div>
      </div>
      </div>

      {/* PR Comment */}
      <AnimatePresence>
        {step === "done" && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.4 }}
            className="rounded-xl border border-border bg-code-bg overflow-hidden"
          >
            <div className="flex items-start gap-3 p-4">
              {/* Bot avatar */}
              <div className="shrink-0 h-8 w-8 rounded-full bg-accent/15 border border-accent/30 flex items-center justify-center">
                <span className="text-xs font-mono font-bold text-accent">C</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-medium">creek-bot</span>
                  <span className="text-[11px] text-muted-foreground font-mono">just now</span>
                  <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">bot</span>
                </div>
                <div className="text-sm text-muted-foreground leading-relaxed space-y-2">
                  <p>
                    <span className="inline-flex items-center gap-1 mr-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      <span className="text-accent font-medium">Preview deployed</span>
                    </span>
                    for commit <code className="text-xs bg-background/50 border border-border rounded px-1.5 py-0.5 font-mono">a3f8c21</code>
                  </p>
                  <div className="rounded-lg border border-border bg-background/30 px-3 py-2 font-mono text-xs">
                    <span className="text-muted-foreground">Preview: </span>
                    <span className="text-accent">{previewUrl}</span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Minimal syntax coloring without a full highlighter */
function colorize(line: string): React.ReactNode {
  return line
    .replace(/(export|default|function|return|const)/g, "§kw§$1§/kw§")
    .replace(/(".*?")/g, "§str§$1§/str§")
    .replace(/(className)/g, "§attr§$1§/attr§")
    .split(/(§\/?(?:kw|str|attr)§)/)
    .reduce<{ result: React.ReactNode[]; currentTag: string | null }>(
      (acc, part) => {
        if (part === "§kw§") return { ...acc, currentTag: "kw" };
        if (part === "§str§") return { ...acc, currentTag: "str" };
        if (part === "§attr§") return { ...acc, currentTag: "attr" };
        if (part.startsWith("§/")) return { ...acc, currentTag: null };
        if (part === "") return acc;

        const cls =
          acc.currentTag === "kw"
            ? "text-[#c792ea]"
            : acc.currentTag === "str"
              ? "text-[#c3e88d]"
              : acc.currentTag === "attr"
                ? "text-[#82aaff]"
                : "";
        acc.result.push(
          <span key={acc.result.length} className={cls}>
            {part}
          </span>,
        );
        return acc;
      },
      { result: [], currentTag: null },
    ).result;
}
