# @solcreek/sdk

## 0.4.19

- **Pre-bundled workers beside their assets.** `planDeploy` treats a built
  `.js`/`.mjs`/`.cjs` worker in a non-root directory that contains the asset
  output (e.g. `worker = "dist/worker.js"`, `output = "dist/assets"`) as
  upload-as-is, instead of wrapping and re-bundling it as source (which failed
  with `Could not resolve "creek"` for projects that don't depend on `creek`).
  The doctor's runtime-dependency rule uses the same definition.
- **`[build] run_worker_first`** in `creek.toml`: `true` or a non-empty list of
  route patterns, resolved into the config for `creek deploy` to send.
- **Custom-domain DNS records.** `DomainDnsInstruction` gains `apex` and
  `records` (`DomainDnsRecord`: type, name, value, purpose); `cname` stays.
  `ActivateDomainResult.status` gains `pending_edge`.

## 0.4.18

- **`CreekClient.planRollback`.** `GET /projects/:id/rollback` — same unbounded
  `triggerType != 'rollback'` selection as `POST /rollback`. Used by
  `creek rollback --dry-run` so the plan cannot disagree with execution when
  the 20-row deployments list is full of synthetic rollback rows.
