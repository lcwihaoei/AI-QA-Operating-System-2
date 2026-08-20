# AI QA Operating System

Provider-neutral autonomous quality platform that combines functional QA, visual/API/device evidence, autonomous fixing, an operational control plane, UX/product intelligence and explicit-learning experiments.

## Current roadmap status

| Milestone | Status | Core capability |
|---|---|---|
| M1 Browser QA | ✅ | Playwright exploration, console/page/network evidence, screenshots/HAR |
| M2 QA Planner | ✅ | coverage graph, deterministic risk policy, bounded planning |
| M3 Visual QA | ✅ | responsive geometry, evidence fusion, explicit visual baselines |
| M4 API/Semantic QA | ✅ | JSON/YAML OpenAPI, schema validation, causal + semantic checks, disposable lifecycle |
| M5 Device QA | ✅ | Appium Android/iOS smoke/explore, app boundary, crash/ANR/log oracles |
| M6 GitHub QA planning | ✅ core | sanitized issue plan + regression memory; no default repository mutation |
| M7 Autonomous Fix Agent | ✅ core | isolated fix branch, bounded model patch, targeted/reproduction/regression gates |
| M8 QA Control Plane | ✅ core | run registry, workers, queue/leases, read-only dashboard |
| M9 UX/Product Intelligence | ✅ core | autonomous non-bug UX opportunities + optional aggregate-only reasoner |
| M10 UX Experiment/Self-Learning | ✅ core | hypotheses, control/variant scoring, guardrails, explicit learning memory |

`main` is not modified by autonomous QA/fix flows. This development branch/PR remains the integration surface until reviewed.

## Standard QA run

```bash
npm install
npx playwright install chromium
npm run qa -- \
  --url https://staging.example.com \
  --risk-mode safe \
  --api-mode safe \
  --visual-viewports desktop,mobile
```

By default M9 UX intelligence is enabled and M6 produces a **local sanitized** `github-issue-plan.json`. Neither creates GitHub issues. Persistent learning/memory remains explicit.

Useful opt-ins:

```bash
# Accept current defect fingerprints as the GitHub regression baseline
npm run qa -- --url https://staging.example.com --update-github-regression-memory

# Record the run in the M8 control plane
npm run qa -- --url https://staging.example.com --control-plane-state .qa-control/state.json

# Accept current UX score/opportunities as the M10 product baseline
npm run qa -- --url https://staging.example.com --ux-product my-product --update-ux-memory
```

## M7 — Autonomous Fix Agent

Plan a fix directly from a QA run result:

```bash
AIQA_FIX_TOKEN=... npm run fix -- \
  --result .qa-runs/<run>/result.json \
  --fingerprint <finding-fingerprint> \
  --repo /path/to/application \
  --fix-endpoint https://fix-gateway.example/propose \
  --mode plan
```

Execution is separately gated:

```bash
AIQA_FIX_TOKEN=... npm run fix -- \
  --result result.json --fingerprint <fingerprint> \
  --repo /path/to/application \
  --fix-endpoint https://fix-gateway.example/propose \
  --mode execute --confirm-write
```

Execute mode requires a clean non-default-branch checkout, creates only `aiqa/fix/<fingerprint>`, validates source SHA-256 before each replacement, rejects sensitive/workflow paths and shell-like verification commands, then requires targeted tests → original reproduction → full regression. Failure rolls back. Success is **not** an automatic commit/push/merge.

See [`docs/FIX_AGENT.md`](docs/FIX_AGENT.md).

## M8 — Control Plane / Dashboard

```bash
npm run dashboard -- --state .qa-control/state.json
```

The control plane stores bounded run summaries, UX score/opportunity counts, worker heartbeats, capability-aware queued jobs, leases and attempt budgets. The dashboard is read-only and loopback-only by default. Remote binding requires `--allow-remote` plus `AIQA_DASHBOARD_TOKEN`.

See [`docs/CONTROL_PLANE.md`](docs/CONTROL_PLANE.md).

## M9 — Autonomous UX / Product Intelligence

M9 runs separately from defect severity. A functionally correct page can still produce UX opportunities for:

- discoverability
- cognitive load
- terminology consistency
- information architecture
- first-time-user clarity
- accessibility naming
- repeated-action/backtracking efficiency

Only aggregate page metrics and bounded flow counters are persisted. Input values and DOM text are not written to the UX report. An optional `AIQA_UX_ENDPOINT` reasoner receives aggregate metrics only and cannot suppress deterministic opportunities.

See [`docs/UX_INTELLIGENCE.md`](docs/UX_INTELLIGENCE.md).

## M10 — UX Experiment / Self-Learning

M10 converts M9 opportunities into hypotheses and evaluates control/variant measurements using UX score, task completion, actions, backtracks, error rate and sample size. Completion/error guardrails override a superficially attractive variant. Tiny samples remain inconclusive.

```bash
npm run ux:experiment -- --input experiment.json
npm run ux:experiment -- --input experiment.json --product my-product --accept-learning
```

Learning memory is read-only until explicitly updated/accepted; the OS does not silently teach itself that every new design is better.

See [`docs/UX_EXPERIMENTS.md`](docs/UX_EXPERIMENTS.md).

## Evidence and privacy

Per-run evidence lives under `.qa-runs/<run-id>/`. The runtime can include:

```text
events.json
result.json
network.har
screenshots/
ux-opportunities.json
github-issue-plan.json
```

Sensitive browser/device/log semantics remain intentionally minimized. UX reasoners receive aggregate metrics, device raw logs are not persisted, semantic values use hashes, and GitHub issue-plan text is sanitized.

## Architecture

```text
                                AI QA Manager
                                     │
      ┌───────────────┬──────────────┼──────────────┬───────────────┐
      ▼               ▼              ▼              ▼               ▼
 Browser/Planner   Visual QA       API QA        Device QA       UX Intelligence
      │               │              │              │               │
      └───────────────┴───────┬──────┴──────────────┴───────────────┘
                              ▼
                     Evidence / Findings / UX
                              │
                  ┌───────────┼────────────┐
                  ▼           ▼            ▼
             GitHub Plan   Fix Agent   UX Experiments
                  │           │            │
                  └───────────┼────────────┘
                              ▼
                         Control Plane
```

The next work after M10 is hardening rather than another required milestone: real-world project adapters, transactional control-plane storage, richer task definitions, and deployment packaging.
