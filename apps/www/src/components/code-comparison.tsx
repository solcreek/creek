import { CodeTabs } from "./code-tabs";
import highlighted from "./highlighted-snippets.json";

const tabs = [
  {
    key: "server",
    label: "Server",
    file: "server.ts",
    callout:
      "db.mutate() auto-broadcasts to all connected clients. No WebSocket code.",
    html: highlighted.server,
  },
  {
    key: "client",
    label: "Client",
    file: "App.tsx",
    callout:
      "useLiveQuery auto-refetches when data changes. Optimistic updates with auto-rollback.",
    html: highlighted.client,
  },
  {
    key: "config",
    label: "Config",
    file: "creek.toml",
    callout:
      "Three lines. Creek provisions the database and realtime service automatically.",
    html: highlighted.config,
  },
];

export function CodeComparison() {
  return <CodeTabs tabs={tabs} />;
}
