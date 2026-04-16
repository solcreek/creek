import { createFileRoute } from "@tanstack/react-router";
import { ResourcesPanel } from "../-components/ResourcesPanel";

export const Route = createFileRoute("/_authenticated/resources/database")({
  component: () => (
    <div className="p-6">
      <h1 className="mb-6 text-xl font-semibold">Database</h1>
      <div className="max-w-3xl">
        <ResourcesPanel kind="database" />
      </div>
    </div>
  ),
});
