import type { ReactNode } from "react";
import Link from "next/link";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-fd-background">
      <header className="border-b border-fd-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link
            href="/"
            className="font-mono text-sm font-medium tracking-tight text-fd-foreground"
          >
            creek
          </Link>
          <nav className="flex gap-6 text-sm text-fd-muted-foreground">
            <Link href="/legal/terms" className="hover:text-fd-foreground">
              Terms
            </Link>
            <Link href="/legal/privacy" className="hover:text-fd-foreground">
              Privacy
            </Link>
            <Link
              href="/legal/acceptable-use"
              className="hover:text-fd-foreground"
            >
              Acceptable Use
            </Link>
            <Link href="/legal/dmca" className="hover:text-fd-foreground">
              DMCA
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">{children}</main>
    </div>
  );
}
