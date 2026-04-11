/**
 * @solcreek/og — OpenGraph image primitives for Creek.
 *
 * This package is the library form of the og.creek.dev service.
 *
 * STATUS: internal-only. Consumed by `packages/og-api` via workspace
 * reference. Not yet published to npm — see
 * `packages/og-api/src/index.ts` Phase 2 notes.
 *
 * Future public API (0.1.0 on npm):
 *   import {
 *     ImageResponse,
 *     deployButtonCard,
 *     brandCard,
 *     creekBrand,
 *   } from "@solcreek/og";
 *
 *   export default {
 *     async fetch() {
 *       return new ImageResponse(brandCard(), { width: 1200, height: 630 });
 *     }
 *   }
 *
 * The `ImageResponse` export is a transparent re-export of the same
 * primitive from `workers-og`. Creek users can consume this package
 * the way Vercel users consume `@vercel/og` — the difference is that
 * pre-baked Creek templates and brand tokens are available alongside it.
 */

// Re-export the low-level image response primitive so consumers only
// need one import.
export { ImageResponse } from "workers-og";

// Brand tokens — shared palette, gradients, and font stacks.
export { creekBrand } from "./brand.js";
export type { CreekBrand } from "./brand.js";

// Pre-baked card templates.
export {
  deployButtonCard,
  type DeployButtonCardProps,
} from "./templates/deploy-button.js";
export { brandCard } from "./templates/creek-brand.js";
