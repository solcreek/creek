import { legalSource } from "@/lib/source";
import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";

export default async function LegalPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const page = legalSource.getPage([slug]);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <article className="prose prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-a:text-fd-primary prose-a:no-underline hover:prose-a:underline">
      <h1 className="text-3xl font-bold">{page.data.title}</h1>
      {page.data.description && (
        <p className="text-fd-muted-foreground text-lg mt-2">
          {page.data.description}
        </p>
      )}
      <hr className="my-8 border-fd-border" />
      <MDX components={{ ...defaultMdxComponents }} />
    </article>
  );
}

export function generateStaticParams() {
  return legalSource.generateParams().map((p) => ({
    slug: p.slug?.[0] ?? "",
  }));
}
