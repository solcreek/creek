import { docs, legal } from "@/../.source/server";
import { loader } from "fumadocs-core/source";

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/docs",
});

export const legalSource = loader({
  source: legal.toFumadocsSource(),
  baseUrl: "/legal",
});
