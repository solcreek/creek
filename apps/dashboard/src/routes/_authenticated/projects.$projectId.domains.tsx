import { createFileRoute } from "@tanstack/react-router";
import { useFeatures } from "@/lib/api-context";
import { DomainsPanel } from "./-components/DomainsPanel";

export const Route = createFileRoute("/_authenticated/projects/$projectId/domains")({
  component: DomainsTab,
});

function DomainsTab() {
  const { projectId } = Route.useParams();
  const features = useFeatures();
  // The tab is hidden in creekd mode; this covers a typed-in URL.
  if (!features.customDomains) {
    return (
      <p className="text-sm text-muted-foreground">
        Custom domains are not available on this server.
      </p>
    );
  }
  return <DomainsPanel projectId={projectId} />;
}
