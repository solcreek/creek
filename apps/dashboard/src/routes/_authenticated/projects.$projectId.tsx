import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  component: ProjectLayout,
  errorComponent: ({ error }) => (
    <div className="p-6 text-red-400">
      <p className="font-semibold">Project Layout Error</p>
      <pre className="mt-2 text-xs">{error.message}</pre>
    </div>
  ),
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const location = useLocation();
  const path = location.pathname;

  const isAnalyticsTab = path.endsWith("/analytics");
  const isLogsTab = path.endsWith("/logs");
  const isEnvTab = path.endsWith("/env");
  const isSettingsTab = path.endsWith("/settings");
  const isDeploymentsTab =
    !isAnalyticsTab && !isLogsTab && !isEnvTab && !isSettingsTab;

  const tabClass = (active: boolean) =>
    `pb-2 text-sm ${active ? "border-b-2 border-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="p-6">
      <div className="mb-6">
        <Link to="/projects" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Projects
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{projectId}</h1>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-4 border-b border-border">
        <Link to="/projects/$projectId" params={{ projectId }} className={tabClass(isDeploymentsTab)}>
          Deployments
        </Link>
        <Link to="/projects/$projectId/analytics" params={{ projectId }} className={tabClass(isAnalyticsTab)}>
          Analytics
        </Link>
        <Link to="/projects/$projectId/logs" params={{ projectId }} className={tabClass(isLogsTab)}>
          Logs
        </Link>
        <Link to="/projects/$projectId/env" params={{ projectId }} className={tabClass(isEnvTab)}>
          Environment
        </Link>
        <Link to="/projects/$projectId/settings" params={{ projectId }} className={tabClass(isSettingsTab)}>
          Settings
        </Link>
      </div>

      <Outlet />
    </div>
  );
}
