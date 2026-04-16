import { createResourceCommand } from "./resource-cmd.js";

export const storageCommand = createResourceCommand({
  kind: "storage",
  label: "storage bucket",
  defaultBinding: "STORAGE",
});
