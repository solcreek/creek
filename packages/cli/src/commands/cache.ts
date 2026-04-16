import { createResourceCommand } from "./resource-cmd.js";

export const cacheCommand = createResourceCommand({
  kind: "cache",
  label: "cache namespace",
  defaultBinding: "KV",
});
