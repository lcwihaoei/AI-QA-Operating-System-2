# Architecture

## Goal

AI QA Operating System coordinates specialized agents instead of coupling the product to one testing vendor.

```text
AI QA Manager
├── QA Planner / Coverage Graph [M2 complete]
│   ├── Human-like Safety Policy
│   ├── Synthetic Input Strategy
│   ├── Page State Analyzer
│   ├── Scenario Generator
│   ├── Heuristic Ranking
│   └── Optional Planner Model Gateway
├── Browser Explorer (Playwright) [implemented]
├── Visual Agent                [M3 active]
│   ├── DOM Geometry Analyzer
│   ├── Responsive Viewport Matrix
│   ├── In-memory Session Bridge
│   └── Optional Evidence Provider + Fusion Policy
├── Functional Agent            [later]
├── API Agent                   [later]
├── Mobile Agent (Appium)       [later]
├── Evidence Engine             [implemented MVP]
├── Bug Analyzer / Deduplicator [implemented MVP]
├── GitHub Issue Adapter        [later]
├── Fix Agent                   [later]
└── Regression Gate             [later]
```

## Design rules

1. Core orchestration stays vendor-neutral.
2. Every reported defect must have evidence and a stable fingerprint.
3. Agents run with explicit action, time, origin and mutation budgets.
4. Destructive and financially sensitive actions are disabled regardless of planner-model output.
5. Planner models may reprioritize only candidates that have already passed the deterministic safety policy.
6. Synthetic field exploration never sources credentials or personal data from the user.
7. Model/provider failure must degrade to deterministic local behavior rather than abort the QA run.
8. Page-state inference and scenario generation remain deterministic so a model cannot invent permission to execute an action.
9. Visual/tooling/provider failures are telemetry unless there is product evidence.
10. Geometry/vision visual findings use bounded severity until multiple independent evidence sources justify higher confidence.
11. Authentication storage state may cross agent boundaries only in memory and must not be serialized into QA evidence by default.
12. Screenshot transmission is opt-in; non-loopback visual endpoints must use HTTPS and never receive storage state.
13. Fix agents never write directly to the protected default branch.
14. A fix is accepted only after targeted verification and regression gates pass.

## Planning boundary

`PageStateAnalyzer` reduces the current DOM into bounded signals and archetypes such as authentication, settings, admin, commerce, search and form. `ScenarioGenerator` maps those archetypes to explicit QA intents. `HumanLikePolicy` remains authoritative for permission and risk. `QaPlanner` computes a deterministic base score from novelty, coverage, scenario relevance, semantic interest, depth and risk.

An optional `PlannerModel` receives coverage, page state, scenarios and candidate context. It can return bounded score deltas only. It cannot modify `allowed`, reduce a blocked risk classification, or directly execute browser actions. The HTTP model adapter uses an AIQA-owned JSON contract so OpenAI, Anthropic, local models or another service can later sit behind the gateway without changing the core planner.

## Visual boundary

`VisualAgent` is intentionally separate from `BrowserExplorer`. The explorer decides where to go and which safe interactions to exercise. The visual layer receives the resulting URL set plus an in-memory Playwright storage-state snapshot and checks responsive geometry using the requested `desktop`, `tablet` and/or `mobile` profiles.

The storage-state bridge exists only inside the run process. `BrowserStorageState` is returned by the explorer to `QaManager`, passed directly into visual browser contexts, and omitted from `QaRunResult`, events and evidence files. Visual telemetry exposes only whether session state was reused.

`DomGeometryAnalyzer` emits objective, bounded signals for document horizontal overflow, interactive controls outside/cut off by the viewport, text clipped by overflow geometry and substantial overlap between independent interactive controls.

When an optional `VisualEvidenceProvider` is configured, only screenshots that already have deterministic signals are submitted for `confirm`, `reject` or `uncertain` assessment. `fuseVisualEvidence` validates indexes, clamps confidence and prevents a single vision provider from deleting or escalating deterministic defects. A high-confidence rejection may downgrade medium to low; confirmation cannot promote above the geometry ceiling.

`HttpVisualEvidenceProvider` uses an AIQA-owned contract, caps a screenshot at 8 MiB and enforces HTTPS except for loopback development endpoints. Provider timeout/error/invalid output falls back to geometry-only behavior.

This layering means future OpenAI vision, local VLMs, Applitools or another provider can sit behind the visual boundary without becoming the source of permission or severity truth.

## Run state

A QA run moves through `PLANNED -> EXPLORING -> ANALYZING -> REPORTED -> FIXING -> RETESTING -> PASSED|FAILED`.

M1 and M2 implement the provider-neutral browser exploration/planning kernel. M3 now has deterministic responsive geometry, authenticated storage-state reuse and optional screenshot evidence fusion; remaining M3 work focuses on baseline/regression semantics and optional provider-specific adapters.
