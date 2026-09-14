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

Committed sample: `20260914T205800Z-help-schema` (Launch → environment doctor → `drive.sh help-schema` → Cleanup). Scratch `/tmp/creek-verify-20260914T205800Z-help-schema` was removed; this tree remained. Do not commit secrets, `CREEK_TOKEN`, or copies of `~/.creek`.
