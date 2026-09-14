# Artifacts

Proof from running this skill. Cleanup (`scripts/cleanup.sh`) deletes `/tmp/creek-verify-$RUN_ID` only — **never this directory**.

Layout after a run:

```
artifacts/
  LAST_RUN_ID
  <RUN_ID>/
    run.json
    launch/
    doctor/
    drive/
    cleanup.json
```

Commit a successful sample run with the skill so a cold agent can see expected shapes. Do not commit secrets, `CREEK_TOKEN`, or copies of `~/.creek`.
