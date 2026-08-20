# M8 QA Control Plane / Dashboard

M8 adds an operational layer above individual QA runs.

## Capabilities

- bounded persistent run registry with severity/coverage/action summaries
- worker heartbeat + declared capabilities
- priority job queue with required-capability matching
- lease ownership, attempt budgets, retry/fail transitions
- read-only JSON state endpoint and a dependency-free dashboard UI
- dashboard refreshes without exposing mutation endpoints

## Dashboard safety

`npm run dashboard` binds to `127.0.0.1` by default. Non-loopback binding requires both `--allow-remote` and `AIQA_DASHBOARD_TOKEN`. Remote requests must use the bearer token. The dashboard exposes GET/HEAD only and contains no job/issue/fix mutation controls.

```bash
npm run dashboard -- --state .qa-control/state.json
```

Remote example:

```bash
AIQA_DASHBOARD_TOKEN='strong-secret' npm run dashboard -- \
  --state .qa-control/state.json \
  --host 0.0.0.0 \
  --allow-remote
```

The current store is a single-coordinator JSON state backend. `ControlPlaneStore` is intentionally separated from the HTTP dashboard so a transactional database/Redis queue can replace the persistence layer without changing QA agents.
