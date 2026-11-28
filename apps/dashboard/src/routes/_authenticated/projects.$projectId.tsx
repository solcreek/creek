import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { useFeatures, useApiMode } from "@/lib/api-context";
import { RouteErrorFallback } from "@/components/route-error";

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  component: ProjectLayout,
  errorComponent: RouteErrorFallback,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const location = useLocation();
  const mode = useApiMode();
  const features = useFeatures();
  const path = location.pathname;

  const tabs =
    mode === "creekd"
      ? [
          { to: "" as const, label: "Overview", match: (p: string) => !p.endsWith("/logs") },
          { to: "logs" as const, label: "Logs", match: (p: string) => p.endsWith("/logs") },
        ]
      : [
          {
            to: "" as const,
            label: "Deployments",
            match: (p: string) =>
              !p.endsWith("/analytics") &&
              !p.endsWith("/logs") &&
              !p.endsWith("/env") &&
              !p.endsWith("/settings"),
          },
          ...(features.analytics
            ? [
                {
                  to: "analytics" as const,
                  label: "Analytics",
                  match: (p: string) => p.endsWith("/analytics"),
                },
              ]
            : []),
          { to: "logs" as const, label: "Logs", match: (p: string) => p.endsWith("/logs") },
          ...(features.envVars
            ? [
                {
                  to: "env" as const,
                  label: "Environment",
                  match: (p: string) => p.endsWith("/env"),
                },
              ]
            : []),
          {
            to: "settings" as const,
            label: "Settings",
            match: (p: string) => p.endsWith("/settings"),
          },
        ];

  const tabClass = (active: boolean) =>
    `pb-2 text-sm ${active ? "border-b-2 border-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`;

  const backLabel = mode === "creekd" ? "Apps" : "Projects";

  return (
    <div className="p-4 md:p-6">
      <div className="mb-6">
        <Link to="/projects" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; {backLabel}
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{projectId}</h1>
      </div>

      {/* Scrolls sideways on narrow screens instead of pushing the page wider. */}
      <div className="mb-6 -mx-4 flex gap-4 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] md:mx-0 md:px-0">
        {tabs.map((tab) => (
          <TabLink key={tab.label} projectId={projectId} to={tab.to} active={tab.match(path)}>
            {tab.label}
          </TabLink>
        ))}
      </div>

      <Outlet />
    </div>
  );
}

function TabLink({
  projectId,
  to,
  active,
  children,
}: {
  projectId: string;
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const cls = `shrink-0 whitespace-nowrap pb-2 text-sm ${active ? "border-b-2 border-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`;
  if (to === "") {
    return (
      <Link to="/projects/$projectId" params={{ projectId }} className={cls}>
        {children}
      </Link>
    );
  }
  if (to === "logs") {
    return (
      <Link to="/projects/$projectId/logs" params={{ projectId }} className={cls}>
        {children}
      </Link>
    );
  }
  if (to === "analytics") {
    return (
      <Link to="/projects/$projectId/analytics" params={{ projectId }} className={cls}>
        {children}
      </Link>
    );
  }
  if (to === "env") {
    return (
      <Link to="/projects/$projectId/env" params={{ projectId }} className={cls}>
        {children}
      </Link>
    );
  }
  if (to === "settings") {
    return (
      <Link to="/projects/$projectId/settings" params={{ projectId }} className={cls}>
        {children}
      </Link>
    );
  }
  return <span className={cls}>{children}</span>;
}
