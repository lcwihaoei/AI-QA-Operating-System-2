# v0.10.0-beta.10 Task Breakdown

This plan implements `docs/BETA10_PRD.md` in small, reviewable checkpoints. The order is deliberate: fix report correctness and model observability first, then interaction-state exploration, then duplicate/evidence quality, then real-project release gates.

Do not merge, tag or deploy as part of these tasks unless the final release step is separately and explicitly approved.

## Conventions

Priority:

- **P0** — release blocker / correctness / safety
- **P1** — core Beta.10 product requirement
- **P2** — hardening / operator experience

Status values for execution tracking:

- `TODO`
- `IN_PROGRESS`
- `BLOCKED`
- `DONE`

Every implementation task must include tests in the same checkpoint or the immediately following test task before proceeding to a new subsystem.

---

# Sprint 0 — Lock the evidence contract

Goal: convert the Beta.9 real-project observations into deterministic Beta.10 acceptance fixtures before changing behavior.

### B10-S0-01 — Add Beta.9 LeeEngUI acceptance summary fixture

Priority: P0

Status: TODO

Create a sanitized fixture containing only non-sensitive metrics from the preserved real run:

- 3 visited user routes;
- 7 model-run actions;
- page coverage 100;
- interaction coverage 16;
- 74 findings;
- first-page planner schema error;
- `ux.reasonerUsed=false`;
- 3 videos.

Do not commit user absolute paths, API keys, raw private-project source or full private evidence.

Acceptance:

- fixture contains no secret or absolute home-directory path;
- fixture can drive regression assertions without requiring LeeEngUI source.

Depends on: none.

### B10-S0-02 — Add report-artifact regression fixture for percentage units

Priority: P0

Status: TODO

Create a minimal result/report input representing `pageCoverage=100` and `interactionCoverage=16`.

Acceptance:

- current Beta.9 renderer fails the new assertion because it renders 10000%/1600%;
- test is isolated and deterministic.

Depends on: none.

### B10-S0-03 — Add planner malformed-schema provider fixture

Priority: P0

Status: TODO

Local HTTP fixture:

1. first response contains valid JSON but omits `recommendations`;
2. optional second response contains valid schema;
3. a second scenario returns malformed schema twice.

Acceptance:

- no external MiniMax call;
- reproduces the real first-page Zod failure shape.

Depends on: none.

Checkpoint exit: evidence fixtures merged into branch and CI green except intentionally red acceptance test if implemented test-first in a temporary commit; final checkpoint must return green.

---

# Sprint 1 — Report correctness and evidence truthfulness

Goal: never present wrong metrics or imply evidence that is not attached.

### B10-S1-01 — Fix percentage rendering units

Priority: P0

Status: TODO

Files likely affected:

- `src/reporting/evidence-report.ts`
- report tests

Change HTML rendering so coverage values already expressed as percentage points are not multiplied again.

Acceptance:

- 100 → `100%`;
- 16 → `16%`;
- 0 → `0%`;
- JSON, HTML and Markdown representations agree.

Depends on: B10-S0-02.

### B10-S1-02 — Add report metric consistency tests

Priority: P0

Status: TODO

Acceptance:

- parses generated HTML and report-data.json;
- verifies coverage score, page coverage, interaction coverage, findings and actions agree;
- includes 0, 16 and 100 boundary cases.

Depends on: B10-S1-01.

### B10-S1-03 — Add evidence-availability reason to report model

Priority: P1

Status: TODO

For findings without screenshot evidence, add a bounded reason instead of a generic empty box only.

Suggested values:

- `not-captured-at-signal-time`
- `non-visual-finding`
- `evidence-path-rejected`
- `capture-failed`

Acceptance:

- report data distinguishes missing evidence from intentionally unavailable evidence;
- no absolute unsafe evidence path is accepted.

Depends on: none.

### B10-S1-04 — Attach nearest valid same-state snapshot to BrowserExplorer UI signals

Priority: P1

Status: TODO

Prefer deterministic association from same URL/state and bounded time window; if unsafe/ambiguous, retain explicit unavailable reason.

Acceptance:

- UI signal card has screenshot or explicit reason;
- no screenshot from a different route/state is attached.

Depends on: B10-S1-03 and state fingerprint utility from Sprint 3 if needed. If state fingerprint is required, defer implementation but keep model field now.

Checkpoint exit: report artifact from fixture is numerically correct and evidence completeness semantics are explicit.

---

# Sprint 2 — AI planner reliability and fallback observability

Goal: model-enabled runs must prove whether the model actually participated.

### B10-S2-01 — Introduce `ModelExecutionSummary`

Priority: P0

Status: TODO

Add additive result fields without breaking Beta.9 readers:

- configured;
- provider/model;
- pagesAttempted;
- pagesModelUsed;
- pagesFallback;
- repairAttempts;
- transportErrors;
- schemaErrors;
- status.

Acceptance:

- heuristic run reports `not-configured`;
- all-model run reports `active`;
- mixed run reports `partial-fallback`;
- zero successful model pages with configured model reports `unavailable`.

Depends on: none.

### B10-S2-02 — Add typed model error categories

Priority: P1

Status: TODO

Do not persist full unbounded exception dumps as the primary machine signal.

Suggested error codes:

- `transport-timeout`
- `http-retryable`
- `http-nonretryable`
- `invalid-json`
- `schema-invalid`
- `response-too-large`
- `unknown-provider-error`

Human-readable bounded diagnostics may still be retained.

Acceptance:

- no API key/token in diagnostics;
- planner summary counts schema vs transport failure correctly.

Depends on: B10-S2-01.

### B10-S2-03 — Add one bounded schema-repair attempt

Priority: P0

Status: TODO

On JSON that parses but fails planner schema validation:

- keep original validation diagnostic;
- perform at most one schema-specific repair call;
- use sanitized/bounded context only;
- record repair attempt and outcome;
- if second response still fails, deterministic fallback remains available.

Do not convert missing `recommendations` to `[]` locally.

Acceptance:

- malformed-first / valid-second fixture uses model after repair;
- malformed-first / malformed-second fixture falls back visibly;
- transport retry budget remains independent.

Depends on: B10-S0-03, B10-S2-02.

### B10-S2-04 — Surface planner status in CLI summary

Priority: P1

Status: TODO

Acceptance:

CLI JSON includes aggregate planner status; model label alone is no longer the only indication of execution.

Depends on: B10-S2-01.

### B10-S2-05 — Surface planner status in evidence report

Priority: P1

Status: TODO

Add compact report metrics:

- AI configured;
- pages AI-used;
- fallback pages;
- repair attempts;
- status chip.

Acceptance:

- report never says `AI Active` if all pages fell back;
- HTML/JSON agree.

Depends on: B10-S2-01, B10-S1-02.

### B10-S2-06 — Add planner fallback regression tests

Priority: P0

Status: TODO

Cases:

1. no model;
2. model valid all pages;
3. first page repaired;
4. one page fallback;
5. all pages fail;
6. provider timeout.

Depends on: B10-S2-01 through B10-S2-05.

Checkpoint exit: first-page Beta.9 schema defect is either repaired or visibly classified as fallback; silent degradation is impossible.

---

# Sprint 3 — UX reasoner observability

Goal: stop collapsing reasoner exceptions into unexplained `reasonerUsed:false`.

### B10-S3-01 — Extend UX summary diagnostics

Priority: P0

Status: TODO

Add additive fields:

- `reasonerConfigured`;
- `reasonerAttempted`;
- `reasonerUsed`;
- `reasonerErrorCode?`;
- optional bounded `reasonerDiagnostic?`.

Acceptance:

- configured + successful call → attempted=true, used=true;
- configured + exception → attempted=true, used=false, error code present;
- not configured → attempted=false, used=false.

Depends on: none.

### B10-S3-02 — Preserve provider error safely from UxAgent

Priority: P1

Status: TODO

Replace bare `catch { reasonerUsed=false }` with bounded diagnostics.

Acceptance:

- no raw token/provider secrets in result;
- deterministic UX analysis still succeeds if reasoner fails.

Depends on: B10-S3-01.

### B10-S3-03 — UX reasoner provider regression suite

Priority: P1

Status: TODO

Cases:

- valid response;
- schema-invalid response;
- timeout;
- non-retryable HTTP error.

Acceptance:

Result clearly explains why model UX enrichment was absent.

Depends on: B10-S3-01, B10-S3-02.

### B10-S3-04 — Surface UX reasoner state in CLI/report/dashboard

Priority: P2

Status: TODO

Use status language such as:

- `Not configured`
- `Used`
- `Attempted · failed`

Do not claim intentional skip unless code actually has a skip policy.

Depends on: B10-S3-01.

Checkpoint exit: the real Beta.9 model-run observation `reasonerUsed:false` would be diagnosable without reading source code.

---

# Sprint 4 — State-aware autonomous exploration

Goal: improve interaction coverage by revisiting page state after real UI changes, not by blindly raising quotas.

### B10-S4-01 — Add stable candidate fingerprint

Priority: P0

Status: TODO

Create deterministic bounded candidate fingerprint from stable UI attributes.

Prefer:

- candidate kind;
- role/tag;
- accessible label;
- normalized href path;
- input name/placeholder;
- stable test identifier;
- owning form/dialog/controlled-region identity.

`locatorIndex` remains execution metadata, not the durable identity.

Acceptance:

- same logical control across harmless rerender keeps fingerprint;
- two same-label controls in different owners remain distinguishable;
- no user-entered field value is included in fingerprint.

Depends on: none.

### B10-S4-02 — Add page interaction-state fingerprint

Priority: P0

Status: TODO

Bounded fingerprint based on safe structural state:

- path;
- expanded/selected dialog/menu states;
- visible stable candidate fingerprints;
- form/dialog counts;
- selected tab identifiers where available.

Do not hash entire raw DOM or sensitive text.

Acceptance:

- opening/closing drawer changes state;
- irrelevant clock/random text does not create infinite state churn.

Depends on: B10-S4-01.

### B10-S4-03 — Re-collect/re-plan after material state change

Priority: P0

Status: TODO

Replace the stale single-page candidate loop with bounded frontier refresh.

Acceptance:

- after app toggler changes state, previously collected locator indices are not blindly executed;
- new visible controls can enter the frontier;
- action budget remains global;
- state loop cannot exceed configured budget.

Depends on: B10-S4-02.

### B10-S4-04 — Add `(route,state,candidate)` loop prevention

Priority: P0

Status: TODO

Acceptance:

- repeated open/close toggles cannot consume the entire run indefinitely;
- repeated actions are auditable with reason `duplicate-state-action`.

Depends on: B10-S4-02.

### B10-S4-05 — Add clickability/interception preflight

Priority: P1

Status: TODO

Before full timeout, verify candidate remains visible/enabled and perform bounded hit-target/interception check where possible.

Acceptance:

- pointer-intercepted candidate exits quickly with reason code;
- material state change triggers replan;
- genuine unintended overlap can still become a finding only through evidence-backed detector logic.

Depends on: B10-S4-03.

### B10-S4-06 — Add state-transition Chromium fixture modeled on LeeEngUI toggler

Priority: P0

Status: TODO

Fixture must reproduce:

- toggler changes sidebar state;
- candidate list changes;
- a previously valid locator index becomes stale/intercepted.

Acceptance:

Beta.10 refreshes and continues safely without a repeated 3-second stale click timeout.

Depends on: B10-S4-03, B10-S4-05.

### B10-S4-07 — Expand safe interaction selection beyond fixed 1–3 slots when budget allows

Priority: P1

Status: TODO

Current selection reserves at most three non-link interactions per page. Replace the hard cap with a dynamic quota driven by:

- global action budget;
- unexplored state frontier;
- eligible safe candidate count;
- route breadth pressure.

Do not starve navigation.

Acceptance:

- link-heavy page retains route breadth;
- interaction-rich page can exercise >3 meaningful safe interactions when budget permits;
- destructive/medium-risk policy unchanged.

Depends on: B10-S4-04.

Checkpoint exit: stateful interaction tests pass and exploration no longer relies on stale `locatorIndex` candidates after material state changes.

---

# Sprint 5 — Coverage semantics and explainable gaps

Goal: replace a misleading single interaction percentage with auditable eligible coverage.

### B10-S5-01 — Define candidate terminal reason codes

Priority: P0

Status: TODO

Implement bounded enum for non-exercised candidates:

- budget-exhausted
- duplicate-state-action
- blocked-by-risk-policy
- stale-after-state-change
- not-visible
- pointer-intercepted
- auth-gated
- unsupported-control
- navigation-duplicate
- execution-error

Acceptance:

- every terminal candidate has exactly one primary reason;
- reason can be aggregated without storing sensitive text.

Depends on: B10-S4-01.

### B10-S5-02 — Implement eligible interaction coverage

Priority: P0

Status: TODO

Compute:

- discovered;
- allowed;
- eligible;
- exercised;
- raw percentage;
- eligible percentage;
- gap counts by reason.

Acceptance:

- denominator rules are documented and unit-tested;
- blocked/destructive candidates do not penalize eligible coverage;
- budget-exhausted safe candidates remain gaps.

Depends on: B10-S5-01.

### B10-S5-03 — Preserve legacy coverage fields

Priority: P1

Status: TODO

Add new fields without breaking existing Beta.9 result consumers.

Depends on: B10-S5-02.

### B10-S5-04 — Surface coverage gap reasons in report/dashboard

Priority: P1

Status: TODO

Show top gap reason counts and expandable details.

Acceptance:

Operator can answer why interaction coverage stopped without manually reading hundreds of planner events.

Depends on: B10-S5-02.

### B10-S5-05 — LeeEngUI eligible coverage acceptance test

Priority: P0

Status: TODO

Using sanitized fixture / local real-project result validator, assert:

- 100% route coverage;
- target >=80% eligible interaction coverage;
- zero unexplained eligible gaps.

If an interaction is legitimately ineligible, reason must be machine-readable rather than manually removed from denominator.

Depends on: B10-S4-07, B10-S5-02.

Checkpoint exit: coverage is explainable and cannot be improved by denominator manipulation without tests noticing.

---

# Sprint 6 — Visual intelligence and finding clustering

Goal: eliminate duplicate review noise while preserving true positives and raw evidence.

### B10-S6-01 — Complete collapsed controlled-region suppression tests

Priority: P0

Status: TODO

Cases:

- `aria-controls` + `aria-expanded=false` displaced descendants → suppress;
- visible control in same shell → analyze;
- unrelated CSS transform → analyze;
- hidden/inert/aria-hidden/data-state closed → suppress as intentional state.

Depends on: existing Beta.10 implementation.

### B10-S6-02 — Add genuine visual negative-control matrix

Priority: P0

Status: TODO

Real Chromium cases:

- visible control entirely outside viewport;
- horizontal document overflow;
- accidental text clipping;
- interactive overlap;
- normal below-fold content.

Acceptance:

No false-positive fix may make these regressions disappear.

Depends on: B10-S6-01.

### B10-S6-03 — Define deterministic finding cluster key

Priority: P1

Status: TODO

Cluster key should normalize:

- kind / visual kind;
- stable element fingerprint;
- controlled region / component identity when known;
- normalized cause signature;
- related element for overlap.

Acceptance:

- same sidebar issue across desktop/tablet/mobile can cluster;
- unrelated same-title findings do not cluster.

Depends on: B10-S4-01.

### B10-S6-04 — Generate additive finding clusters

Priority: P1

Status: TODO

Raw findings remain unchanged.

Add cluster summary:

- cluster id/title;
- highest severity;
- routes/viewports;
- raw finding ids;
- representative evidence.

Depends on: B10-S6-03.

### B10-S6-05 — Render clusters in evidence report

Priority: P1

Status: TODO

Default reviewer view may be cluster-first, with expandable raw findings.

Acceptance:

- raw IDs are still discoverable/searchable;
- finding count and cluster count are both shown;
- no raw evidence is deleted.

Depends on: B10-S6-04.

### B10-S6-06 — Add duplicate-noise acceptance fixture

Priority: P1

Status: TODO

Use a synthetic set resembling the Beta.9 74-finding sidebar repetition.

Acceptance:

- cluster count is substantially lower;
- raw count remains exactly identical;
- highest severity preserved.

Depends on: B10-S6-04.

Checkpoint exit: review load is reduced without suppressing raw findings or genuine geometry defects.

---

# Sprint 7 — Route manifest and real-project harness hardening

Goal: make the Beta.10 release gate runnable even when the target project is private.

### B10-S7-01 — Finish route-manifest security matrix

Priority: P0

Status: TODO

Verify/retest:

- JSON array;
- JSON object;
- newline file;
- deduplication;
- max 200;
- `javascript:` rejected;
- `file:` rejected;
- URL credentials rejected;
- cross-origin rejected by default;
- same run/evidence/action budget.

Depends on: existing implementation.

### B10-S7-02 — Add external dogfood result verifier CLI/script

Priority: P1

Status: TODO

Because the AI-QA repository token cannot necessarily checkout a private target repository, create a verifier that consumes a locally produced Beta.10 `result.json`, `events.json` and report metadata.

It SHALL validate:

- candidate version/SHA metadata if supplied;
- route coverage;
- eligible interaction coverage;
- planner fallback status;
- UX reasoner diagnostics;
- evidence counts;
- collapsed-sidebar cluster absence;
- report metric consistency.

It SHALL NOT require committing private target source/evidence into AI-QA.

Acceptance:

- deterministic exit code for PASS/BLOCKED/FAIL;
- no secret material copied into repository.

Depends on: Sprints 1–6 result schemas.

### B10-S7-03 — Document private-repository dogfood workflow

Priority: P2

Status: TODO

Document local/authorized runner execution without making target repository public.

Depends on: B10-S7-02.

### B10-S7-04 — Remove temporary write-capable patch/publisher workflows

Priority: P0

Status: TODO

Audit `.github/workflows` for one-shot branch writers used during development.

Acceptance:

- long-lived Beta.10 release line contains only intended CI/release permissions;
- release remains exact-tag gated;
- no branch push can publish a release.

Depends on: none.

Checkpoint exit: real dogfood can be verified without weakening private-repo access controls.

---

# Sprint 8 — Governance regression and release candidate

Goal: prove exploration changes did not weaken Beta.9 mutation safety.

### B10-S8-01 — Run full Beta.9 governance regression suite

Priority: P0

Status: TODO

Must cover:

- selection;
- fix-plan generation;
- approval hash;
- scope hash;
- clean/non-default branch;
- exact file/SHA restrictions;
- targeted/regression/Beta7 QA gates;
- correlation;
- retry authorization;
- attempt budget;
- no push/merge/deploy.

Depends on: Sprints 1–7.

### B10-S8-02 — Clean-clone release reproducibility

Priority: P0

Status: TODO

From fresh clone:

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

CI remains on deterministic lockfile install.

Depends on: current lockfile work.

### B10-S8-03 — Security/repository safety scan

Priority: P0

Status: TODO

Verify:

- no secrets/private keys;
- no accidental private dogfood artifacts;
- no files > repository policy size;
- no merge markers;
- no write-capable temporary workflows;
- `npm audit --audit-level=high` release gate.

Depends on: B10-S7-04.

### B10-S8-04 — Heuristic LeeEngUI Beta.10 dogfood

Priority: P0

Status: TODO

Use pinned target baseline and fresh workspace.

Acceptance:

- route coverage 100%;
- eligible interaction coverage target >=80% or verifier explains a legitimate non-applicability with zero unexplained eligible gaps;
- report units correct;
- historical collapsed false-positive cluster absent;
- true-positive visual controls still proven by regression suite;
- governance does not mutate target.

Depends on: B10-S7-02.

### B10-S8-05 — MiniMax LeeEngUI Beta.10 dogfood

Priority: P0 when credentials available; otherwise release blocker must be explicitly waived, not silently skipped.

Status: TODO

Acceptance:

- planner status `active` or visible `partial-fallback`;
- no unexplained first-page fallback;
- UX reasoner attempted/used/error state explicit;
- compare eligible coverage/actions/clusters with heuristic run;
- no target mutation.

Depends on: B10-S2-06, B10-S3-04, B10-S7-02.

### B10-S8-06 — Update version and release metadata to `0.10.0-beta.10`

Priority: P0

Status: TODO

Only after functional release gates are green.

Update consistently:

- package version;
- lockfile root version;
- release manifest;
- release notes;
- release candidate checklist;
- README references if required.

Depends on: B10-S8-01 through B10-S8-05.

### B10-S8-07 — Exact-SHA final CI

Priority: P0

Status: TODO

Run full CI on final candidate SHA.

Acceptance:

- build green;
- full Vitest green;
- real Chromium green;
- security/audit green;
- package dry-run green;
- release metadata consistency green.

Depends on: B10-S8-06.

### B10-S8-08 — Prepare release, do not publish automatically

Priority: P0

Status: TODO

Produce final release-readiness report containing:

- exact SHA;
- dogfood verifier outputs;
- before/after Beta.9 vs Beta.10 metrics;
- planner fallback metrics;
- UX reasoner state;
- finding/cluster counts;
- governance result;
- known residual issues.

Stop before tag creation and await explicit release approval.

Depends on: B10-S8-07.

---

# Recommended execution order

1. Sprint 0 — evidence fixtures
2. Sprint 1 — report correctness
3. Sprint 2 — planner reliability/observability
4. Sprint 3 — UX reasoner observability
5. Sprint 4 — state-aware exploration
6. Sprint 5 — eligible coverage
7. Sprint 6 — visual/clustering/evidence quality
8. Sprint 7 — dogfood harness/security hygiene
9. Sprint 8 — governance + release candidate

Do not parallelize state-fingerprint/candidate-identity changes with coverage-denominator changes until the fingerprint contract is stable.

---

# Beta.10 release dashboard

Track these release metrics at every checkpoint:

| Metric | Beta.9 real model run | Beta.10 target |
|---|---:|---:|
| Route coverage | 100% | 100% |
| Raw interaction coverage | 16% | informational |
| Eligible interaction coverage | not available | >=80% on pinned dogfood |
| Model pages used | 2/3 | explicit, no unexplained fallback |
| Planner schema error | 1 known | 0 unexplained; repair/fallback visible |
| UX reasoner diagnostic | `reasonerUsed:false` only | configured/attempted/used/error explicit |
| Raw findings | 74 | preserved as emitted |
| Finding clusters | not available | additive, deterministic |
| HTML page coverage | incorrect `10000%` | correct `100%` |
| HTML interaction coverage | incorrect `1600%` | correct units |
| Governance violation | 0 | 0 |

---

# Definition of Done for every task

A task is `DONE` only when:

1. implementation exists on the Beta.10 branch;
2. focused tests cover the behavior;
3. no test was weakened merely to make CI pass;
4. security/governance behavior is unchanged unless the PRD explicitly requires a stricter rule;
5. CI result is checked on the exact commit;
6. docs/task status are updated when the checkpoint is stable.