"use client";

import { use } from "react";

const DEMO_URL = "https://todo-demo.creek.dev";

export default function LiveSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      {/* Banner */}
      <div className="border-b border-border bg-[oklch(0.12_0_0)] px-6 py-3">
        <div className="mx-auto max-w-5xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="font-mono text-sm font-medium tracking-tight hover:text-accent transition-colors"
            >
              creek
            </a>
            <span className="text-xs text-muted-foreground">
              You&apos;re viewing a live demo session
            </span>
          </div>
          <a
            href="/"
            className="text-xs font-mono text-accent hover:underline"
          >
            Start your own
          </a>
        </div>
      </div>

      {/* Full-screen demo */}
      <div className="flex-1 relative">
        <iframe
          src={`${DEMO_URL}/?room=${sessionId}`}
          className="absolute inset-0 w-full h-full border-0"
          allow="clipboard-write"
        />
      </div>
    </div>
  );
}
