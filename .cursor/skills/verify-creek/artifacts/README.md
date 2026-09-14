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

The committed sample is regenerated after helper changes so it matches the current evidence format (`tree-before.json` / `tree-after.json`, `filesModified`, `observedNoProjectMutation` / `observedNoHomeMutation`). See `LAST_RUN_ID` for the directory name. Scratch `/tmp/creek-verify-$RUN_ID` was removed; this tree remained. Do not commit secrets, `CREEK_TOKEN`, `VERIFY_CREEK_TOKEN`, or copies of `~/.creek`.
