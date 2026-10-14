/**
 * Per-sandbox CF resource provisioning.
 *
 * Given a bundle's declared binding requirements (e.g. EmDash needs a
 * D1 "DB" + R2 "MEDIA" + KV "SESSION"), allocate one ephemeral
 * Cloudflare resource per binding scoped to this sandbox. The result
 * is both:
 *
 *   1. A `WfPBinding[]` that the deploy-core passes to the CF Workers
 *      API when uploading the tenant script.
 *   2. A `ProvisionedResources` record stored in the `deployments`
 *      table so `cleanup.ts` can delete everything when the sandbox
 *      expires 60 minutes later.
 *
 * Naming convention: `sbox-{sandboxId}-{bindingName}` (lowercase). The
 * `sbox-` prefix makes orphaned resources easy to spot in the CF
 * dashboard / API when debugging or doing emergency cleanup.
 *
 * Failures during provisioning abort the whole deploy — a half-wired
 * sandbox would crash with 1101 on every request, which is worse than
 * an explicit "provisioning failed" error.
 */

import {
  createD1Database,
  createR2Bucket,
  createKVNamespace,
  type WfPBinding,
} from "@solcreek/deploy-core";
import { aliasPartner, deprecatedAliasBindings } from "@solcreek/sdk/bindings";
import type { Env } from "./types.js";

export interface BindingRequirement {
  type: string;
  bindingName: string;
}

/** Shape of `deployments.provisionedResources` JSON column. */
export interface ProvisionedResources {
  d1?: Array<{ binding: string; name: string; id: string }>;
  r2?: Array<{ binding: string; name: string }>;
  kv?: Array<{ binding: string; title: string; id: string }>;
}

/**
 * Provision every D1 / R2 / KV binding declared in the bundle.
 * Returns the deploy-time `WfPBinding[]` for the CF Workers API
 * alongside a `ProvisionedResources` record for later cleanup.
 */
export async function provisionSandboxResources(
  env: Env,
  sandboxId: string,
  requirements: readonly BindingRequirement[],
): Promise<{ bindings: WfPBinding[]; provisioned: ProvisionedResources }> {
  const bindings: WfPBinding[] = [];
  const provisioned: ProvisionedResources = {};

  // One name, one binding, as production deploys require: refuse a bundle
  // that declares a name with two types (a framework adapter's IMAGES beside
  // the user's own IMAGES bucket) before creating anything, rather than fail
  // at the Workers upload with resources already made.
  const declared = new Map<string, string>();
  const unique: BindingRequirement[] = [];
  for (const req of requirements) {
    const earlier = declared.get(req.bindingName);
    if (earlier === undefined) {
      declared.set(req.bindingName, req.type);
      unique.push(req);
    } else if (earlier !== req.type) {
      throw new Error(
        `${req.bindingName} is declared as both ${earlier} and ${req.type}. Give each binding its own name.`,
      );
    }
  }

  // D1 / KV id provisioned under each binding name so far, with its type:
  // a partner of another type (a KV named DB beside a D1 DATABASE) is not
  // shared.
  const idByName = new Map<string, { type: string; id: string }>();

  for (const req of unique) {
    const name = `sbox-${sandboxId}-${req.bindingName.toLowerCase()}`;
    // DATABASE and DB (CACHE and KV) declared together share one resource,
    // as in production, so the app and migrations see the same database.
    // Cleanup is unaffected — the second name adds a binding, not a resource.
    const partner = aliasPartner(req.bindingName, req.type);
    const shared = partner ? idByName.get(partner) : undefined;
    const sharedId = shared?.type === req.type ? shared.id : undefined;
    if (sharedId) {
      bindings.push(
        req.type === "d1"
          ? { type: "d1", name: req.bindingName, id: sharedId }
          : { type: "kv_namespace", name: req.bindingName, namespace_id: sharedId },
      );
      idByName.set(req.bindingName, { type: req.type, id: sharedId });
      continue;
    }
    switch (req.type) {
      case "d1": {
        const id = await createD1Database(env, name);
        idByName.set(req.bindingName, { type: req.type, id });
        bindings.push({
          type: "d1",
          name: req.bindingName,
          id,
        });
        (provisioned.d1 ??= []).push({ binding: req.bindingName, name, id });
        break;
      }
      case "r2": {
        await createR2Bucket(env, name);
        bindings.push({
          type: "r2_bucket",
          name: req.bindingName,
          bucket_name: name,
        });
        (provisioned.r2 ??= []).push({ binding: req.bindingName, name });
        break;
      }
      case "kv": {
        const id = await createKVNamespace(env, name);
        idByName.set(req.bindingName, { type: req.type, id });
        bindings.push({
          type: "kv_namespace",
          name: req.bindingName,
          namespace_id: id,
        });
        (provisioned.kv ??= []).push({
          binding: req.bindingName,
          title: name,
          id,
        });
        break;
      }
      // Declare-only bindings — no resource to provision, just include
      // in the deploy metadata so `env.LOADER` / `env.IMAGES` etc. are
      // defined when the Worker boots. These are account-level CF
      // features (Dynamic Workers / CF Images) and require the
      // appropriate plan; the deploy will fail at the CF API layer
      // if the account lacks the entitlement.
      case "worker_loader": {
        bindings.push({ type: "worker_loader", name: req.bindingName });
        break;
      }
      case "images": {
        bindings.push({ type: "images", name: req.bindingName });
        break;
      }
      // Other binding types (ai, analytics_engine, durable_object, etc.)
      // aren't provisioned per-sandbox today. Silently skip so deploys
      // with those bindings still succeed with the provisionable subset.
      default:
        break;
    }
  }

  // The deprecated aliases production binds (DB for DATABASE, KV for CACHE),
  // pointing at the same sandbox resource: a Worker that reads env.DB must
  // behave the same in the preview as in production (#61). Cleanup is
  // unaffected — an alias adds a binding, not a resource.
  bindings.push(...deprecatedAliasBindings(bindings));

  return { bindings, provisioned };
}
