# Product / Feature Planner

The Product / Feature Planner is a governed planning surface in the AI QA management dashboard. It turns a product request into an explicit, reviewable implementation contract **before** any source mutation is allowed.

## Purpose

The planner exists to prevent a coding agent from jumping directly from a vague feature request to implementation. It separates product intent from source mutation and records the decisions that must remain stable during implementation and QA.

The workflow is:

1. **Opportunity** — record the requested product outcome, current problem, expected impact, estimated effort, affected areas, current product understanding and design-system constraints.
2. **Decision interview** — explicitly confirm target users, feature outcome, compatibility expectations, design-system boundary, data sensitivity and release strategy.
3. **Blueprint** — select one of the reviewed implementation alternatives and explicitly state user flow, information architecture, frontend, backend, data and security requirements.
4. **Frozen work plan** — create a dependency-ordered feature plan covering product contract, frontend, backend and integrated Beta.7 QA.

## Safety boundary

Feature planning is deliberately separate from implementation.

- Every generated WorkItem begins with `mutationAllowed: false`.
- Every generated WorkItem requires explicit approval.
- Planning APIs do not execute source changes, git operations, deployment or migrations.
- A frozen blueprint is written with exclusive-create semantics and cannot silently overwrite the reviewed contract.
- Required answers must be explicitly confirmed; missing or unsupported values block blueprint generation.
- Inputs and artifact sizes are bounded.
- The dashboard action endpoints remain loopback-only and require `--allow-actions`.
- Remote authenticated dashboard access remains read-only.
- Existing dashboard CSP remains free of `unsafe-inline`.

The generated integration task requires native regression plus Beta.7 evidence-rich QA before the feature can be considered accepted.

## Dashboard

The management dashboard injects a **Features / 功能規劃** entry. The page follows the existing management-dashboard visual system and inherits System / Light / Dark theme behavior.

The same planner supports the global language switch:

`繁體 | English`

Desktop uses the left navigation. On mobile, the planner is available from the responsive bottom navigation and its forms collapse to a single-column layout.

## Artifacts

By default the planner writes to `.qa-features/`:

- `planning-session.json`
- `planning-answers.json`
- `feature-blueprint.json`

The artifact root can be changed with:

```bash
aiqa-dashboard --feature-artifacts <dir>
```

These files are planning artifacts, not permission to modify product source code.

## Dashboard API

Read-only state:

```text
GET /api/features
```

Loopback action mode only:

```text
POST /api/features/create
POST /api/features/answer
POST /api/features/blueprint
```

A dashboard must be started with `--allow-actions` before those POST operations are enabled.

## Verification

The feature-planning slice includes:

- deterministic planner tests for required confirmations and WorkItem dependency ordering;
- persistence/freeze tests for the dashboard service;
- HTTP lifecycle tests for opportunity → interview → immutable blueprint;
- generated JavaScript compilation validation;
- real Chromium bilingual desktop/mobile dashboard regression;
- Beta.8 frontend-discovery dogfood fixtures covering React, Vue, Svelte, Angular and vanilla frontends, plus ignored secret/build-tree cases.

The planner intentionally does not auto-approve or auto-execute its generated WorkItems. Those permissions belong to the separate governed implementation/execution workflow.
