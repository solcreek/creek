# Production serving: what the URL serves vs. what Creek says it serves

A TLA+ model of one project's production deploys, checked with TLC.

- **Property.** The production URL serves the code of the deployment that `project.productionDeploymentId` names (`ServesProduction`), and that deployment is `active` (`ProductionIsActive`).
- **Harm when it breaks.** The CLI, dashboard and API tell a user that production is one deployment while the URL serves another. A rollback that changes nothing a visitor sees is the sharpest case.

## How production is routed

Every deploy uploads two Workers for Platforms scripts (`deployWithAssets`, `deploy.ts`): an immutable `{project}-{shortId}-{team}`, then the mutable `{project}-{team}`. The dispatch worker (`packages/dispatch-worker/src/index.ts`, `resolveRoute`, `productionScriptName`) serves a production hostname, and a project's custom domains, from the **immutable script of the deployment `productionDeploymentId` points at**. A deploy's activation, promote and rollback all move that pointer, so all of them change what is served, within the dispatch worker's route cache (60 s).

The mutable script still receives every production deploy: cron triggers and the queue consumer run there.

The model has a constant `RouteByPointer`. `TRUE` is the current routing. `FALSE` is the routing before it, when production was served from the mutable script, which only a deploy writes; the `legacy-*` scenarios keep it so the check is seen to fail on the bugs that routing caused.

## Findings

Each one is the shortest path TLC found. Findings 1-4 were replayed against the real `runDeployJob` and routes in `replay.test.ts.txt` (see "Replay").

Fixed by routing production by the pointer (now `pass`; the `legacy-*` scenarios still show them):

1. **Rollback and promote changed nothing a visitor saw** (`legacy-rollback`, `legacy-promote`). Deploy 1 goes live, deploy 2 goes live, roll back (or promote) to deploy 1: `productionDeploymentId` = deploy 1, the URL kept serving deploy 2 until the next production deploy.
2. **Two production deploys at once could leave the URL and the pointer apart** (`legacy-concurrent`). Nothing stops two jobs for one project. Deploy 1 uploads the production script, then deploy 2 does; deploy 2 activates, then deploy 1 does: the URL served deploy 2, Creek said deploy 1.
3. **A deploy that failed after its production upload stayed live, marked failed** (`legacy-failures`). Deploy 2 uploads the production script, then its activation batch fails (D1 error) or its job dies: the URL served deploy 2, which is `failed`; Creek said deploy 1.

Open:

4. **A deploy can be production and `failed` at once** (`failures-active`). The activation batch commits, then the manifest write to R2 throws. `failDeployment` marks the production deployment `failed`. It is still served (its script exists); the status is wrong.

Not covered by this model, and still true of the mutable script: cron triggers and the queue consumer run the latest production deploy's code, not the deployment the pointer names, after a rollback or promote.

## Scope, bounds, assumptions

- One project, three deployments, all on the production branch. `MaxRunning` jobs at once (1, or 2 in `concurrent`).
- Each modelled step is one atomic step of the code; a throwing step has no effect.
- The stale-deploy reaper (`sweepStaleDeployments`) fails only rows whose job died: the model assumes the heartbeat keeps a live job's row fresh.
- Nothing deletes an immutable script. If a cleanup ever does, production of a project pointing at that deployment answers 404: add the deletion to the model.
- Promote and rollback refuse a synthetic `rollback` row as a target (it has no script); the model has no such rows.
- **Not modelled:** branch and preview scripts (not production); the route cache's 60 s lag; the queued-row sweep (it fails rows that never started); custom domains (they route like the default hostname); creekd and local deploy targets (`DEPLOY_TARGET`); Cloudflare applying a script upload partially; cron and queue (see above).
- A pass covers this model within these bounds, not the whole system.

## Run

```sh
formal/production-serving/run.sh            # all scenarios, compared with expected.txt
formal/production-serving/run.sh rollback   # one scenario
formal/production-serving/check-sync.sh     # has the modelled code changed since the model was last checked against it?
```

Needs Java 11+ (`JAVA_HOME`, a JDK under `~/.local/opt/jdk-*`, or `java` on `PATH`). `run.sh` downloads tla2tools v1.7.4 once into `~/.cache/creek-formal/` and checks its sha256. Exit 0 means every scenario matched `expected.txt`; 1 means one changed; 2 means the check could not run. A full run takes a few seconds.

The routing itself is pinned by `packages/dispatch-worker/src/production-pointer.test.ts`.

## Replay

`replay.test.ts.txt` replays each finding against the real control-plane code (MSW for the Cloudflare API, the local D1/R2 test env). For findings 1-3 it shows what the mutable script holds against the pointer, which is what the old routing served. It is kept out of the test suite. To run it:

```sh
cp formal/production-serving/replay.test.ts.txt packages/control-plane/src/modules/deployments/zz-formal-replay.test.ts
pnpm vitest run packages/control-plane/src/modules/deployments/zz-formal-replay.test.ts
rm packages/control-plane/src/modules/deployments/zz-formal-replay.test.ts
```
