# v0.10.0-beta.10 PRD — Autonomous Exploration & Real-Project Hardening

Status: Draft for implementation

Release line: `feature/v0.10.0-beta.10-real-project-hardening`

Parent release: immutable `v0.10.0-beta.9`

## 1. Product intent

Beta.10 is the release that turns the Beta.9 QA loop from a mostly deterministic browser/visual scanner with optional model ranking into a trustworthy autonomous exploration system for real frontends.

The release does **not** replace Beta.9 governance. It strengthens the quality of discovery, interaction, model observability, evidence and reporting while keeping selection → plan → approval → bounded execution → fresh QA → correlation as the mutation boundary.

Beta.10 is evidence-driven. Its requirements come from two clean-room LeeEngUI runs against the immutable Beta.9 release plus the earlier LeeEngUI dogfood that exposed the collapsed/off-canvas false-positive cluster.

## 2. Evidence baseline

### 2.1 Clean-room no-model run

Observed against LeeEngUI `62b0f430eaf39d2ad1834ebdab89b6718957b0fc`:

- 3/3 user routes visited;
- 6 executed actions;
- coverage score 61;
- page coverage 100%;
- interaction coverage 14%;
- 74 findings;
- 15 screenshots and 3 viewport videos;
- governance did not mutate the target without approval.

### 2.2 Clean-room MiniMax model run

Observed with `MINIMAX_API_KEY` configured:

- 3/3 user routes visited;
- 7 executed actions;
- coverage score 62;
- page coverage 100%;
- interaction coverage 16%;
- 74 findings, identical visual fingerprints to the heuristic run;
- first-page planner call failed schema validation because `recommendations` was missing, then silently fell back to heuristic;
- the UX reasoner was configured but `reasonerUsed` was false.

Important correction: current source attempts the configured UX reasoner whenever snapshots exist, then catches failures and only returns `reasonerUsed: false`. Therefore Beta.10 must expose whether the reasoner was attempted and why it failed; it must not infer that the reasoner was intentionally skipped.

### 2.3 Report correctness defect discovered by the real artifact

`report-data.json` stores page coverage as `100` and interaction coverage as `16`, but the generated HTML multiplies those values by 100 again, displaying `10000%` and `1600%`.

This is a release-blocking report correctness defect because a valid run can produce materially false executive metrics.

### 2.4 Interaction-state defect observed in events

After the app toggler changed the page state, the explorer continued using candidates collected before that state transition. The next candidate click timed out while another control intercepted pointer events. Beta.10 must treat state-changing interactions as a reason to refresh the interaction frontier instead of continuing a stale locator-index plan.

## 3. Product goals

Beta.10 MUST:

1. make model usage and fallback visible and machine-readable;
2. repair or explicitly fail/fallback on malformed model output without silently pretending the model was used;
3. increase safe interaction exploration through state-aware replanning rather than simply increasing click counts;
4. distinguish route coverage from eligible interaction coverage and explain every remaining gap;
5. suppress intentional collapsed/off-canvas geometry without masking genuine clipping/overflow;
6. cluster duplicate visual signals while preserving every raw finding/evidence item;
7. attach actionable evidence to findings consistently;
8. produce numerically correct HTML/JSON/Markdown reports;
9. preserve Beta.9 approval, execution, correlation and retry boundaries;
10. pass a repeatable real-project dogfood gate before tag creation.

## 4. Non-goals

Beta.10 will NOT:

- introduce automatic merge, push or deployment;
- weaken or bypass Beta.9 human approval;
- build the Beta.8 backend-generation workflow again;
- add unrestricted cross-origin crawling;
- use model output as a substitute for deterministic evidence;
- claim all controls must be exercised when they are destructive, blocked, unreachable by product design, auth-gated or unsafe;
- silently coerce invalid model output into apparently valid recommendations;
- modify target lockfiles, secrets or workflow files through the fix agent.

## 5. Primary users

### QA operator

Needs to know whether the run actually used the configured model, what was explored, what was skipped, why coverage stopped and whether a finding is backed by evidence.

### Product / engineering reviewer

Needs a compact issue set rather than dozens of duplicated viewport variants, while retaining raw evidence for audit.

### Fix approver

Needs the existing Beta.9 governance guarantees unchanged.

## 6. Core product requirements

### 6.1 AI execution observability

Every run SHALL expose a structured planner status:

```json
{
  "configured": true,
  "provider": "minimax-cn",
  "model": "MiniMax-M3",
  "pagesAttempted": 3,
  "pagesModelUsed": 2,
  "pagesFallback": 1,
  "repairAttempts": 1,
  "transportErrors": 0,
  "schemaErrors": 1,
  "status": "partial-fallback"
}
```

Allowed status values:

- `not-configured`
- `active`
- `partial-fallback`
- `unavailable`

Planner events SHALL retain page-level `modelUsed` and an error code, but secrets, raw API keys and unbounded provider payloads MUST NOT be persisted.

The CLI summary, report JSON and dashboard SHALL surface the aggregate state. A user must never see a model label that implies full AI execution when all calls fell back.

### 6.2 Bounded schema-repair path

For provider responses that contain JSON but fail the expected planner schema:

1. preserve the first validation diagnostic;
2. permit at most one bounded schema-repair request using the same sanitized context and a strict schema reminder;
3. if repair succeeds, record `repairUsed=true`;
4. if repair fails, fall back to deterministic ranking and record `partial-fallback` or `unavailable`;
5. never fabricate missing recommendations locally merely to satisfy the schema.

Transport retries remain separate from schema repair.

### 6.3 UX reasoner observability

The UX result SHALL distinguish:

- configured;
- attempted;
- used;
- failed;
- not configured.

At minimum add:

```ts
reasonerConfigured: boolean
reasonerAttempted: boolean
reasonerUsed: boolean
reasonerErrorCode?: string
```

A caught reasoner exception MUST no longer collapse to an unexplained `reasonerUsed:false`.

### 6.4 State-aware exploration frontier

The explorer SHALL not treat one page URL as one immutable state.

After a successful interaction, it SHALL compute a bounded state-change signal using deterministic inputs such as:

- URL/path change;
- dialog/menu expanded state;
- relevant `aria-expanded` / `aria-selected` / `data-state` changes;
- visible candidate-set change;
- form/field count change;
- stable DOM/interaction fingerprint.

If state materially changes, the explorer SHALL refresh candidates and re-plan rather than continue stale `locatorIndex` candidates.

The explorer MUST maintain an attempt budget and prevent loops by tracking `(route, state fingerprint, candidate fingerprint)`.

### 6.5 Stable candidate identity

`locatorIndex` may be retained as an execution hint, but MUST NOT be the only identity anchor after state transitions.

Candidate fingerprints SHOULD prefer bounded stable signals:

- tag/role;
- accessible name;
- href/path;
- name/placeholder;
- `data-testid` or equivalent stable test attribute when present;
- owning form/dialog/controlled-region identity.

Before mutation-like UI actions, resolve the candidate again and verify it still matches the approved safe candidate fingerprint.

### 6.6 Interaction budget and eligible coverage

Beta.10 SHALL report two separate interaction metrics:

1. raw discovered interaction coverage for backward compatibility;
2. **eligible interaction coverage** where the denominator excludes candidates proven blocked, destructive, auth-gated, stale, duplicate or unreachable by design.

Every non-exercised eligible candidate SHALL have a reason code, for example:

- `budget-exhausted`
- `duplicate-state-action`
- `blocked-by-risk-policy`
- `stale-after-state-change`
- `not-visible`
- `pointer-intercepted`
- `auth-gated`
- `unsupported-control`
- `navigation-duplicate`

The release target is not an arbitrary universal 80% raw score. The acceptance target is **>= 80% eligible interaction coverage on the pinned LeeEngUI dogfood profile**, with zero unexplained eligible gaps. If the target app changes, the denominator and reasons must remain auditable.

### 6.7 Clickability preflight

Before spending the full click timeout on a candidate, the explorer SHOULD perform a bounded interactability check.

If another element intercepts the candidate center or Playwright reports repeated interception:

- record `pointer-intercepted` evidence;
- refresh state/candidates if the page changed;
- avoid repeatedly spending the same timeout on a stale candidate;
- do not automatically classify interception as a product defect unless evidence proves an unintended overlap.

### 6.8 Route knowledge

The existing bounded `--routes-file` remains part of Beta.10.

Requirements stay fail-closed:

- JSON array, `{ "routes": [] }`, or newline format;
- max 200 routes;
- only HTTP/HTTPS;
- URL credentials rejected;
- same-origin by default;
- seeded routes join the same run, queue, HAR, evidence and action budget;
- seed navigation must be identifiable in events.

Known route input improves coverage; it is not authorization to bypass auth or destructive prerequisites.

### 6.9 Visual state awareness

Intentional closed/collapsed regions SHALL be excluded from offscreen/clipping findings only when state evidence supports that conclusion.

Preferred evidence includes:

- `hidden` / `inert` / `aria-hidden=true`;
- `data-state=closed` / `data-open=false`;
- `aria-controls` tied to a controller with `aria-expanded=false` plus displaced controlled content;
- computed `display:none`, `visibility:hidden/collapse`, or effectively transparent hidden state.

A generic CSS transform alone MUST NOT suppress a finding.

Paired negative controls are mandatory: a real visible offscreen control, horizontal document overflow and accidental clipping must still produce findings.

### 6.10 Finding clustering

Beta.10 SHALL keep raw findings immutable, and additionally generate deterministic finding clusters.

A cluster may group repeated instances across route/viewports when they share normalized evidence such as:

- finding kind / visual kind;
- stable selector or element fingerprint;
- controlled-region/component identity;
- normalized root-cause signature.

The report SHALL show:

- cluster title;
- highest severity;
- affected routes/viewports;
- raw finding count;
- representative evidence;
- expandable raw findings.

No raw finding may disappear because of clustering.

### 6.11 Evidence attachment integrity

A finding that can be reproduced visually SHOULD have a screenshot or an explicit reason why no screenshot exists.

For BrowserExplorer UI signals emitted before the normal page snapshot, Beta.10 SHALL either:

- capture evidence at signal time; or
- deterministically correlate the nearest valid snapshot from the same page/state.

The report MUST NOT imply evidence completeness when the finding card has no screenshot and no explicit reason.

### 6.12 Report correctness

Report representations MUST agree on units.

Coverage values are percentage points (`0..100`) in the current result schema; HTML SHALL render `100` as `100%`, not multiply by 100.

Add invariant tests covering:

- 0%;
- fractional percentage points if supported;
- 16%;
- 100%;
- report JSON ↔ HTML ↔ Markdown consistency.

### 6.13 Governance preservation

All Beta.9 invariants remain mandatory:

- explicit finding selection;
- fix plan hash;
- explicit scope approval;
- non-default clean branch/worktree;
- exact file/SHA restrictions;
- targeted test → regression → fresh QA;
- post-QA correlation before completion;
- bounded retry with a new plan and approval;
- no automatic commit/push/merge/deploy outside the existing explicitly governed acceptance behavior.

## 7. Data model additions

Recommended additive fields; do not break existing result consumers.

```ts
interface ModelExecutionSummary {
  configured: boolean;
  provider?: string;
  model?: string;
  pagesAttempted: number;
  pagesModelUsed: number;
  pagesFallback: number;
  repairAttempts: number;
  transportErrors: number;
  schemaErrors: number;
  status: 'not-configured' | 'active' | 'partial-fallback' | 'unavailable';
}

interface InteractionCoverageSummary {
  discovered: number;
  eligible: number;
  exercised: number;
  rawPercent: number;
  eligiblePercent: number;
  gapsByReason: Record<string, number>;
}

interface FindingClusterSummary {
  id: string;
  title: string;
  highestSeverity: Severity;
  rawFindingIds: string[];
  routes: string[];
  viewports: string[];
  representativeFindingId: string;
}
```

Existing fields remain readable during Beta.10.

## 8. CLI / dashboard requirements

CLI final summary SHALL include:

- planner execution status;
- UX reasoner configured/attempted/used/error status;
- route manifest seeded count;
- raw and eligible interaction coverage;
- finding count and cluster count;
- report paths.

Dashboard Run Overview SHOULD expose compact status chips:

- `AI Active`
- `Partial fallback`
- `AI unavailable`
- `Heuristic only`

The UI must not expose secrets or raw model prompts/responses by default.

## 9. Security and privacy requirements

- preserve existing redaction and endpoint HTTPS policy;
- no API keys in events, result, report, logs or artifacts;
- model context remains bounded and sanitized;
- same-origin navigation remains default;
- no new autonomous target-repository mutation path;
- provider schema repair receives only the already-sanitized planner context and bounded validation diagnostics;
- no hidden background retries beyond documented budgets.

## 10. Test strategy

### Unit / contract

- provider JSON extraction and schema repair;
- planner summary state transitions;
- UX reasoner error observability;
- stable candidate fingerprinting;
- eligible-coverage denominator/reason codes;
- clustering determinism;
- report percentage correctness.

### Real Chromium

At minimum:

1. collapsed controlled sidebar → no false visual finding;
2. visible offscreen action → finding;
3. horizontal document overflow → finding;
4. normal below-fold content → no finding;
5. state-changing drawer/menu interaction → candidate refresh, no stale locator loop;
6. pointer interception → bounded failure reason, no repeated timeout loop;
7. unlinked route seeded by manifest → visited in the same run.

### Provider integration fixture

A local provider fixture SHALL simulate:

- valid response;
- missing `recommendations` on first response then valid repair response;
- repeated invalid schema leading to visible fallback;
- transient HTTP failure;
- UX reasoner invalid response with surfaced error state.

### Real-project dogfood

Pinned LeeEngUI baseline remains the Beta.10 release gate.

Run at least:

- heuristic profile;
- MiniMax model profile when credentials are available.

Compare against preserved Beta.9 evidence, not against memory or manually edited counts.

## 11. Release acceptance criteria

Beta.10 is release-ready only if all are true:

1. `npm ci` succeeds from a clean clone using the committed lockfile;
2. `npm audit --audit-level=high` passes the project gate;
3. TypeScript, Vitest and real Chromium suites pass;
4. report percentage regression is fixed and tested;
5. no silent planner fallback: every fallback has structured status/diagnostic;
6. UX reasoner failure cannot appear as an unexplained `reasonerUsed:false`;
7. stale interaction candidates are refreshed after material state change;
8. LeeEngUI reaches >=80% eligible interaction coverage or every remaining eligible gap is explicitly justified and the metric calculation demonstrates why the threshold is not applicable;
9. the historical collapsed/sidebar false-positive cluster does not reproduce under the Beta.10 state-aware detector;
10. genuine visible offscreen/overflow/clipping negative controls still fail correctly;
11. finding clusters reduce duplicate review load while preserving all raw finding IDs;
12. evidence report cards either carry screenshot evidence or an explicit evidence-unavailable reason;
13. Beta.9 governance/correlation/retry tests remain green;
14. package/release metadata agree on `0.10.0-beta.10` on the final candidate;
15. release workflow remains exact-tag gated; no merge, tag or deployment happens before explicit release approval.

## 12. Success metrics

For the pinned LeeEngUI comparison:

- route coverage: 100%;
- eligible interaction coverage: target >=80%;
- unexplained model fallback: 0;
- unexplained UX reasoner failure: 0;
- report metric unit errors: 0;
- missing-evidence-without-reason cards: 0;
- collapsed/offcanvas false-positive cluster: 0 confirmed QA-engine duplicates;
- raw findings preserved: 100%;
- governance violations: 0.

## 13. Rollout

Beta.10 remains prerelease-only.

Implementation is split into small checkpoints. Each checkpoint must have focused regression tests and a green CI before the next risk area is changed. Release tagging occurs only after the real-project acceptance run and exact-SHA release verification.