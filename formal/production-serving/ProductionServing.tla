---------------------------- MODULE ProductionServing ----------------------------
(***************************************************************************)
(* What a project's production URL serves, and what Creek says it serves. *)
(*                                                                         *)
(* The control plane, the CLI and the dashboard treat                     *)
(* project.productionDeploymentId as "the deployment production serves".  *)
(* The dispatch worker (packages/dispatch-worker/src/index.ts,            *)
(* resolveRoute, productionScriptName) serves a production hostname or    *)
(* custom domain from the immutable script {project}-{shortId}-{team} of  *)
(* that deployment (RouteByPointer = TRUE). Before that it served the     *)
(* mutable script {project}-{team}, which only a deploy writes            *)
(* (RouteByPointer = FALSE, kept so the check is seen to fail on it).     *)
(*                                                                         *)
(* This model checks whether what production serves and the pointer can  *)
(* disagree, across every interleaving of one project's deploy jobs,      *)
(* promote, rollback, step failures, dead jobs and the stale-deploy       *)
(* reaper, within the bounds set in cfg/*.cfg.                             *)
(*                                                                         *)
(* Every action below is one atomic step of the code it names.            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Deployments,   \* deployment rows of one project, all on its production branch
    None,          \* model value: no deployment
    MaxRunning,    \* deploy jobs in flight at once. The code has no per-project
                   \* lock: POST /:projectId/deployments only inserts a row
                   \* (deployments/routes.ts), so several jobs can run together.
    WithPromote,   \* include POST /:projectId/deployments/:id/promote
    WithRollback,  \* include POST /:projectId/rollback
    WithFailures,  \* include failing steps, dying jobs and the stale-deploy reaper
    RouteByPointer \* TRUE: production routes to the pointer's immutable script

VARIABLES
    status,    \* deployment.status. "deploying" stands for uploading,
               \* provisioning and deploying, which the reaper treats alike.
    pc,        \* the next step the deploy job for d runs; "none" = no job
    scripts,   \* deployments whose immutable {project}-{shortId}-{team} exists
    edgeProd,  \* whose code the mutable script {project}-{team} holds
    prodPtr    \* project.productionDeploymentId

vars == <<status, pc, scripts, edgeProd, prodPtr>>

Steps == {"none", "uploadImmutable", "uploadProduction", "activate", "manifest"}

TypeOK ==
    /\ status \in [Deployments -> {"queued", "deploying", "active", "failed"}]
    /\ pc \in [Deployments -> Steps]
    /\ scripts \subseteq Deployments
    /\ edgeProd \in Deployments \cup {None}
    /\ prodPtr \in Deployments \cup {None}

Running == {d \in Deployments : pc[d] # "none"}

Init ==
    /\ status = [d \in Deployments |-> "queued"]
    /\ pc = [d \in Deployments |-> "none"]
    /\ scripts = {}
    /\ edgeProd = None
    /\ prodPtr = None

(* PUT /bundle claims a queued or failed row (deployments/routes.ts:        *)
(* UPDATE ... SET status = 'uploading' WHERE status IN ('queued','failed'))  *)
(* and runs the job (deployments/deploy-job.ts). A failed row, including   *)
(* one the reaper failed, can be claimed again.                            *)
Start(d) ==
    /\ status[d] \in {"queued", "failed"}
    /\ pc[d] = "none"
    /\ Cardinality(Running) < MaxRunning
    /\ status' = [status EXCEPT ![d] = "deploying"]
    /\ pc' = [pc EXCEPT ![d] = "uploadImmutable"]
    /\ UNCHANGED <<scripts, edgeProd, prodPtr>>

(* deployments/deploy.ts deployWithAssets: the immutable                    *)
(* {project}-{shortId}-{team} script goes up first. Nothing deletes it.     *)
UploadImmutable(d) ==
    /\ pc[d] = "uploadImmutable"
    /\ scripts' = scripts \cup {d}
    /\ pc' = [pc EXCEPT ![d] = "uploadProduction"]
    /\ UNCHANGED <<status, edgeProd, prodPtr>>

(* deployments/deploy.ts deployWithAssets: then the mutable production     *)
(* script {project}-{team}. Cron triggers and the queue consumer run there; *)
(* under the old routing, production traffic did too.                       *)
UploadProduction(d) ==
    /\ pc[d] = "uploadProduction"
    /\ edgeProd' = d
    /\ pc' = [pc EXCEPT ![d] = "activate"]
    /\ UNCHANGED <<status, scripts, prodPtr>>

(* deployments/deploy-job.ts step 4 (and instant-deploy.ts, same order):    *)
(* one D1 batch sets the row 'active' and productionDeploymentId = d.       *)
(* Both UPDATEs are unconditional (WHERE id = ?).                          *)
Activate(d) ==
    /\ pc[d] = "activate"
    /\ status' = [status EXCEPT ![d] = "active"]
    /\ prodPtr' = d
    /\ pc' = [pc EXCEPT ![d] = "manifest"]
    /\ UNCHANGED <<scripts, edgeProd>>

(* deployments/deploy-job.ts: env.ASSETS.put(manifest) after the batch.    *)
(* Success ends the job.                                                   *)
WriteManifest(d) ==
    /\ pc[d] = "manifest"
    /\ pc' = [pc EXCEPT ![d] = "none"]
    /\ UNCHANGED <<status, scripts, edgeProd, prodPtr>>

(* The step the job is at throws (Cloudflare API, D1 or R2 error). The     *)
(* catch in runDeployJob calls failDeployment: an unconditional UPDATE      *)
(* ... SET status = 'failed' WHERE id = ?. The throwing step has no effect; *)
(* steps already done are not undone.                                      *)
Fail(d) ==
    /\ WithFailures
    /\ pc[d] # "none"
    /\ status' = [status EXCEPT ![d] = "failed"]
    /\ pc' = [pc EXCEPT ![d] = "none"]
    /\ UNCHANGED <<scripts, edgeProd, prodPtr>>

(* The job's waitUntil context dies (eviction, OOM): it stops where it is, *)
(* its row keeps its in-flight status and its heartbeat stops.             *)
Die(d) ==
    /\ WithFailures
    /\ pc[d] # "none"
    /\ pc' = [pc EXCEPT ![d] = "none"]
    /\ UNCHANGED <<status, scripts, edgeProd, prodPtr>>

(* control-plane/src/index.ts sweepStaleDeployments: an in-flight row with  *)
(* no update for 10 minutes is failed. Assumption: withDeployHeartbeat      *)
(* keeps a live job's row fresh, so only a dead job's row is reaped.       *)
Reap(d) ==
    /\ WithFailures
    /\ status[d] = "deploying"
    /\ pc[d] = "none"
    /\ status' = [status EXCEPT ![d] = "failed"]
    /\ UNCHANGED <<pc, scripts, edgeProd, prodPtr>>

(* deployments/routes.ts POST /:projectId/deployments/:id/promote: an      *)
(* active row becomes production. Only the D1 pointer changes. A synthetic *)
(* 'rollback' row is refused (it has no script of its own).                *)
Promote(d) ==
    /\ WithPromote
    /\ status[d] = "active"
    /\ prodPtr' = d
    /\ UNCHANGED <<status, pc, scripts, edgeProd>>

(* deployments/routes.ts POST /:projectId/rollback: points production at   *)
(* an active row other than the current one, and inserts a synthetic      *)
(* 'rollback' row (not modelled: the pointer names the target, and a      *)
(* rollback row is refused as a target). Only D1 changes.                 *)
Rollback(t) ==
    /\ WithRollback
    /\ prodPtr # None
    /\ status[t] = "active"
    /\ t # prodPtr
    /\ prodPtr' = t
    /\ UNCHANGED <<status, pc, scripts, edgeProd>>

Next ==
    \E d \in Deployments :
        \/ Start(d)
        \/ UploadImmutable(d)
        \/ UploadProduction(d)
        \/ Activate(d)
        \/ WriteManifest(d)
        \/ Fail(d)
        \/ Die(d)
        \/ Reap(d)
        \/ Promote(d)
        \/ Rollback(d)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The deployment whose code a production request runs. Routing by the     *)
(* pointer, a missing immutable script would answer 404 (None).            *)
Served ==
    IF RouteByPointer
    THEN IF prodPtr \in scripts THEN prodPtr ELSE None
    ELSE edgeProd

(* Under the old routing, a deploy job between uploading the production    *)
(* script and activating had moved the edge ahead of the pointer for a     *)
(* moment, by design, so the promise was checked only when no job was      *)
(* there. Routing by the pointer has no such window.                       *)
InWindow == {d \in Deployments : pc[d] = "activate"}
Settled == RouteByPointer \/ InWindow = {}

(* The promise: production serves the deployment Creek calls production.   *)
ServesProduction ==
    (prodPtr # None /\ Settled) => Served = prodPtr

(* The deployment Creek calls production is active.                        *)
ProductionIsActive ==
    prodPtr # None => status[prodPtr] = "active"
=============================================================================
