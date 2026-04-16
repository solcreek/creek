import { createResourceCommand } from "./resource-cmd.js";

export const dbCommand = createResourceCommand({
  kind: "database",
  label: "database",
  defaultBinding: "DB",
});
