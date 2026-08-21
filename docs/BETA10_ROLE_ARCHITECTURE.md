# v0.10.0-beta.10 Role Architecture

Beta.10 hardens AI-QA by separating observation, evidence, judgement and architecture responsibilities. A detector is not allowed to become the final product-defect authority by itself.

## Operating model

```text
QA Orchestrator
  -> State Observer
  -> Explorer
  -> Coverage Auditor
  -> Evidence Collector
  -> Annotation Validator
  -> Reproduction Agent
  -> Finding Judge
  -> Finding Clusterer
  -> Evidence Report
```

Cross-cutting roles:

- Model Watchdog — records configured / attempted / used / repair / fallback / error state for planner, UX and later model-backed subsystems.
- Product Architect — turns feature requests into alternatives, proactive design questions and a reviewed blueprint before implementation.
- System Architect — decides canonical ownership when a capability would otherwise be duplicated across modules.
- Contract Guardian — validates shared data units, state semantics and invariants used across Explorer, Visual, Reporter, Fix and Control Plane.

## Role boundaries

### State Observer

Owns semantic page state: visible, intentionally hidden, not rendered or unknown. It may use explicit relationships such as `aria-controls`, `aria-expanded`, `aria-hidden`, `inert` and bounded geometry. It does not declare a product bug.

### Evidence Collector

Owns screenshots, video references, DOM/geometry, console/network traces and provenance. Missing evidence must be represented explicitly rather than silently omitted.

### Annotation Validator

Confirms whether report annotations correspond to the finding semantics. Overlap findings should eventually carry both element rectangles and the intersection rectangle. It does not infer product intent.

### Reproduction Agent

Runs a bounded independent reproduction after a detector signal. A state-dependent visual finding should be reproduced in the relevant open/closed state before it can become a confirmed product defect.

### Finding Judge

Consumes detector signal + state observation + evidence + annotation + reproduction. It emits one of: confirmed product defect, potential product defect, QA-engine false positive, test defect, environment, or UX opportunity.

### Explorer / Coverage Auditor

Explorer chooses safe unexplored state transitions. Coverage Auditor owns the denominator and terminal gap reasons; route coverage must never be presented as equivalent to interaction/state coverage.

### Product Architect

For new features, the planner must be allowed to challenge the requested solution. It should inspect existing product architecture, offer bounded alternatives, identify omitted constraints and ask for explicit decisions before freezing the blueprint.

### System Architect / Contract Guardian

Shared concepts must have one canonical owner. In particular, Beta.10 targets canonical contracts for:

- page/visibility state;
- candidate identity and eligibility;
- percentage-point coverage metrics;
- model execution status;
- evidence truth and annotation state;
- finding verdicts/clusters;
- governed WorkItem approval state.

A new subsystem may not invent a second incompatible representation for one of these concepts.

## Delivery slices

### Beta.10-A — Evidence Truth

First release slice. Priorities:

1. canonical quality contracts;
2. State Observer contract;
3. Evidence/annotation truth contract;
4. independent reproduction requirement before confirmed product-defect classification;
5. report percentage-unit correctness;
6. screenshot-unavailable reasons.

Exit condition: the system stops turning an unverified detector signal directly into a confident product-defect claim.

### Beta.10-B — Autonomous Exploration

Adds state graph, stale-candidate invalidation, stable candidate identity, Model Watchdog and explainable eligible interaction coverage.

Exit condition: LeeEngUI safe eligible interaction coverage is >= 80% with zero unexplained eligible gaps.

### Beta.10-C — System Intelligence

Adds deterministic finding clusters plus Product / Feature Planner 2.0 proactive design review.

Exit condition: duplicate detector noise is summarized without deleting raw evidence, and new-feature planning can propose/compare alternatives before implementation.

### Beta.10-D — Architecture Consolidation

Makes canonical contracts mandatory across Browser, Visual, Report, Planner, UX, Fix and Control Plane. Duplicate state/coverage/model/evidence representations become release blockers.

Exit condition: cross-module contract tests are green and Beta.10 is not released while parallel incompatible representations remain.

## First implementation checkpoint

The first code checkpoint introduces `src/contracts/quality-contracts.ts` and contract tests for:

- percentage-point semantics (`100 -> 100%`, `16 -> 16%`);
- explicit model fallback diagnostics;
- no confirmed product-defect verdict without independent reproduction;
- explicit reasons for unavailable screenshot evidence.

These contracts are intentionally introduced before broad subsystem rewrites so later integrations have a single target instead of creating another parallel implementation.
