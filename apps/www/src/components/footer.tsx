import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-border py-8 px-6 mt-auto">
      <div className="mx-auto max-w-5xl flex flex-col gap-6 text-xs text-muted-foreground">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 leading-none">
            <span aria-hidden="true" className="text-[1.05em] -translate-y-[0.5px]">⬡</span>
            <span className="font-brand text-base font-medium">Creek</span>
          </span>
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            <Link href="/docs" className="hover:text-foreground transition-colors">Docs</Link>
            <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
            <a href="https://templates.creek.dev" className="hover:text-foreground transition-colors">Templates</a>
            <Link href="/changelog" className="hover:text-foreground transition-colors">Changelog</Link>
            <a href="https://github.com/solcreek/creek" className="hover:text-foreground transition-colors">GitHub</a>
            <a href="https://x.com/useCreek" className="hover:text-foreground transition-colors">X</a>
          </div>
        </div>
        <div className="flex flex-wrap justify-center sm:justify-end gap-x-6 gap-y-2">
          <Link href="/legal/terms" className="hover:text-foreground transition-colors">Terms</Link>
          <Link href="/legal/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
          <Link href="/legal/acceptable-use" className="hover:text-foreground transition-colors">Acceptable Use</Link>
          <Link href="/legal/dmca" className="hover:text-foreground transition-colors">DMCA</Link>
        </div>
      </div>
    </footer>
  );
}
