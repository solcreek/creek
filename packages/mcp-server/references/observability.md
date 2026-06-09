# Creek CLI — Observability

Two distinct log streams, answering different questions:

| Question | Tool |
|----------|------|
| "What happened during my last deploy?" | `creek deployments logs <ID>` |
| "What's my worker doing in production?" | `creek logs` |
| "Why did my deploy fail, and can an agent fix it?" | MCP `get_build_log` |

## Runtime logs — `creek logs`

Per-project tail of `console.log` / `console.error` / uncaught
exceptions for every request your Worker served. Tenant-isolated —
the prefix is derived from the session, not URL params.

```bash
creek logs --json                      # last hour, all outcomes
creek logs --follow                    # live tail via WebSocket
creek logs --outcome exception         # errors only
creek logs --since 24h --search "order"  # free text within a window
creek logs --deployment <id>           # specific deploy
```

Note: **edge-cached HTML requests don't appear** — they never invoke
the worker, so no log event fires. See the Analytics tab in the
dashboard for total HTTP traffic (including cache hits).

## Build logs — `creek deployments logs <id>`

Structured transcript of the deploy pipeline: clone / detect / install
/ build / bundle / upload / provision / activate. Surfaces the
failing step with a `CK-*` diagnostic code and the subprocess stderr.

```bash
creek deployments logs <deployment-id> --json    # agent-safe
creek deployments logs <deployment-id> --raw     # ndjson for piping
creek deployments logs <short-id>                # 8-char prefix works
```

Available for `creek deploy` (CLI), GitHub push deploys, and via the
dashboard's Deployments tab (expandable panel, auto-open on failure).
Web deploys from `creek.dev/new` render the same transcript inline
on failure.

## MCP tool — `get_build_log`

`mcp.creek.dev` exposes `get_build_log` for agents that want to
diagnose a deploy without going through the CLI. Input: Creek API key
+ project slug + deployment id (short or full). Output: summary +
important lines (errors + failing-step lines) + full log.

Pattern: user says "my deploy to Creek failed, can you fix it?" → agent
calls `get_build_log` → reads the `errorCode` + `errorStep` → applies
the corresponding fix. See `references/diagnosis.md` for the CK-*
code-to-fix mapping.
