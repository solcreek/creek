# @solcreek/sdk

## 0.4.18

- **`CreekClient.planRollback`.** `GET /projects/:id/rollback` — same unbounded
  `triggerType != 'rollback'` selection as `POST /rollback`. Used by
  `creek rollback --dry-run` so the plan cannot disagree with execution when
  the 20-row deployments list is full of synthetic rollback rows.
