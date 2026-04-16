import { createFileRoute } from "@tanstack/react-router";
import { ResourcesPanel } from "../-components/ResourcesPanel";

export const Route = createFileRoute("/_authenticated/resources/cache")({
  component: () => (
    <div className="p-6">
      <h1 className="mb-6 text-xl font-semibold">Cache</h1>
      <div className="max-w-3xl">
        <ResourcesPanel kind="cache" />
      </div>
    </div>
  ),
});
