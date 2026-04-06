import Link from "next/link";

const documents = [
  {
    title: "Terms of Service",
    href: "/legal/terms",
    description: "Terms governing your use of Creek services.",
  },
  {
    title: "Acceptable Use Policy",
    href: "/legal/acceptable-use",
    description: "Rules for using Creek services responsibly.",
  },
  {
    title: "Privacy Policy",
    href: "/legal/privacy",
    description: "How Creek collects, uses, and protects your data.",
  },
  {
    title: "DMCA Policy",
    href: "/legal/dmca",
    description: "How Creek handles copyright infringement claims.",
  },
];

export default function LegalIndex() {
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Legal</h1>
      <p className="mt-2 text-fd-muted-foreground">
        Legal documents governing the use of Creek services.
      </p>
      <div className="mt-8 grid gap-4">
        {documents.map((doc) => (
          <Link
            key={doc.href}
            href={doc.href}
            className="block rounded-lg border border-fd-border p-5 transition-colors hover:border-fd-primary/50 hover:bg-fd-accent/5"
          >
            <h2 className="font-semibold">{doc.title}</h2>
            <p className="mt-1 text-sm text-fd-muted-foreground">
              {doc.description}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
