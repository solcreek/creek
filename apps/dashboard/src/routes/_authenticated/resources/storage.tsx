import { createFileRoute } from "@tanstack/react-router";
import { ResourcesPanel } from "../-components/ResourcesPanel";

export const Route = createFileRoute("/_authenticated/resources/storage")({
  component: () => (
    <div className="p-6">
      <h1 className="mb-6 text-xl font-semibold">Storage</h1>
      <div className="max-w-3xl">
        <ResourcesPanel kind="storage" />
      </div>
    </div>
  ),
});
