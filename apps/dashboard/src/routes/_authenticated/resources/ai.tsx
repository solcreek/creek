import { createFileRoute } from "@tanstack/react-router";
import { ResourcesPanel } from "../-components/ResourcesPanel";

export const Route = createFileRoute("/_authenticated/resources/ai")({
  component: () => (
    <div className="p-6">
      <h1 className="mb-6 text-xl font-semibold">AI</h1>
      <div className="max-w-3xl">
        <ResourcesPanel kind="ai" />
      </div>
    </div>
  ),
});
