# Beta.9 — Controlled AI Auto-Fix

Beta.9 closes the loop from a Beta.7 evidence-rich QA report to a reviewed, bounded source change and a fresh Beta.7 verification result. Selection, planning, approval, execution, post-QA correlation and retry authorization are separate gates so a model cannot turn a finding into repository mutation by itself.

## 1. Explicit finding selection

Start from a Beta.7 `result.json` and explicitly choose one or more finding fingerprints:

```bash
npm run beta9 -- select \
  --result .qa-runs/<run-id>/result.json \
  --fingerprint <finding-fingerprint> [more...] \
  --project MyProject \
  --out .qa-beta9/plan.json
```

Only selected findings become WorkItems. Every WorkItem starts with `mutationAllowed=false` and `approval.approved=false`. Selection plans are created immutably; an existing Beta.9 plan is never silently overwritten.

## 2. AI fix plan — read-only until approval

```bash
AIQA_BETA9_TOKEN=... npm run beta9 -- plan-fix \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --repo /path/to/target \
  --model-endpoint https://fix-model-gateway.example/plan
```

The reviewed artifact contains root cause, recommended changes, regression risks, confidence, exact create/replace operations, targeted tests, regression verification, a Beta.7 QA command and a deterministic `planHash`.

Planning is not permission to write. Fix-plan artifacts are immutable and attempt-specific, for example:

```text
.qa-beta9/fix-plans/B9-FIX-...-attempt-1-<plan-hash-prefix>.json
```

A retry creates a new plan instead of modifying the artifact used by a previous immutable attempt record.

## 3. Human approval binds the reviewed plan to source scope

```bash
npm run beta9 -- approve-fix \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --fix-plan .qa-beta9/fix-plans/<immutable-fix-plan>.json \
  --confirm-plan-hash <sha256> \
  --approved-by owner \
  --allow src/components/** test/**
```

The shared WorkItem system computes a separate scope hash. Editing the WorkItem after approval invalidates that approval. The reviewed code changes must all be covered by the allowed repository-relative paths.

The management dashboard is stricter: dashboard approval derives the allowed path list from the exact reviewed change files and does not let the browser submit an arbitrary broad path scope.

## 4. Controlled execution

```bash
npm run beta9 -- execute-fix \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --repo /path/to/target \
  --fix-plan .qa-beta9/fix-plans/<immutable-fix-plan>.json \
  --confirm-plan-hash <sha256> \
  --attempt 1 \
  --confirm-write
```

Safety properties:

- refuses `main`, `master` and `trunk` as execution starting branches;
- requires a clean checkout;
- creates an isolated `aiqa/fix/<work-item>` branch;
- supports bounded create/replace operations only;
- denies Git internals, workflow files, env/credential/key material and lockfiles;
- replacement writes require the exact SHA-256 reviewed during planning;
- verification commands are restricted to test/check/lint/type/build/verify/QA tooling;
- targeted tests run before broader regression and Beta.7 QA;
- mutation/verification failure rolls back and marks the item blocked;
- successful source changes remain uncommitted on the isolated branch for review;
- every attempt emits an immutable attempt record;
- every WorkItem has a bounded attempt budget, default 3.

A successful Beta.7 command exit code does **not** mean the defect is fixed. The item enters `verification` and the attempt becomes `awaiting-correlation` until a fresh Beta.7 result is compared with the source result.

## 5. Post-QA correlation

```bash
npm run beta9 -- correlate \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --before-result .qa-runs/<source-run>/result.json \
  --after-result .qa-runs/<post-run>/result.json \
  --attempt-record .qa-beta9/attempts/<attempt>.json
```

Correlation is conservative:

- `persistent` — exact fingerprint remains;
- `persistent-equivalent` — fingerprint changed but one same-kind/same-route/same-title finding remains;
- `resolved` — exact fingerprint and an equivalent finding are both absent;
- `inconclusive` — multiple equivalent findings prevent a safe automatic conclusion.

New findings are counted. A new critical/high finding blocks automatic retry. The correlation artifact is immutable and has its own deterministic `correlationHash`.

Only `resolved` with no new critical/high regression marks the WorkItem `completed`.

## 6. Bounded retry authorization

A retry requires the previous immutable attempt, the fresh correlation, a still-persistent selected finding, no new critical/high regression and remaining attempt budget.

```bash
npm run beta9 -- prepare-retry \
  --plan .qa-beta9/plan.json \
  --correlation .qa-beta9/correlations/<correlation>.json \
  --attempt-record .qa-beta9/attempts/<attempt>.json \
  --repo /path/to/target
```

If a successful-but-unresolved attempt left uncommitted changes on its isolated branch, retry preparation requires that exact execution branch and rolls those changes back to the recorded original branch. Partial fixes are never silently stacked.

Retry preparation:

- binds authorization to the WorkItem, finding, source run, fresh post run, previous attempt and correlation hash;
- authorizes exactly `previousAttempt + 1`;
- resets the WorkItem to non-mutating `planned` state;
- clears prior approval and allowed paths;
- requires a completely new immutable fix plan and a new approval;
- passes the fresh post-QA context into retry planning so the provider is explicitly told not to repeat the prior approach without new evidence.

Attempt 2+ must confirm the exact retry authorization hash:

```bash
npm run beta9 -- execute-fix \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --repo /path/to/target \
  --fix-plan .qa-beta9/fix-plans/<new-immutable-fix-plan>.json \
  --confirm-plan-hash <new-sha256> \
  --attempt 2 \
  --retry-authorization-hash <authorization-sha256> \
  --confirm-write
```

The authorization is consumed when the retry begins. An attempt above 1 cannot bypass this gate.

## 7. Governed management-dashboard workflow

The dashboard can now drive the same gated lifecycle. It remains read-only unless `--allow-actions` is explicitly enabled on a loopback bind.

Read-only evidence/review mode:

```bash
npm run dashboard -- \
  --host 127.0.0.1 \
  --beta7-result .qa-runs/<source-run>/result.json \
  --beta9-plan .qa-beta9/plan.json
```

Full governed local action mode:

```bash
AIQA_BETA9_TOKEN=... npm run dashboard -- \
  --host 127.0.0.1 \
  --beta7-result .qa-runs/<source-run>/result.json \
  --beta9-plan .qa-beta9/plan.json \
  --beta9-repo /path/to/target \
  --beta9-model-endpoint https://fix-model-gateway.example/plan \
  --beta9-post-result .qa-runs/<fresh-post-run>/result.json \
  --beta9-artifacts .qa-beta9 \
  --allow-actions
```

The Beta.9 page exposes the controlled sequence:

```text
Select findings
  → Generate fix plan
  → Review root cause / exact files / risk / tests / plan hash
  → Approve exact reviewed files
  → Confirm exact plan-hash suffix
  → Execute on isolated branch
  → Targeted tests / regression / Beta.7
  → Correlate fresh Beta.7 result
  → Completed OR prepare bounded retry
  → New plan + new approval for retry
```

Dashboard security boundaries:

- action mode is loopback-only even if remote read access has a bearer token;
- the request Host must itself be a loopback host, reducing DNS-rebinding exposure;
- cross-site requests are rejected and an Origin, when present, must match the dashboard Host;
- POST actions require JSON and have a bounded request-body size;
- repository path, model endpoint, source/post-result paths, artifact directory and model token are server startup configuration and cannot be supplied by browser requests;
- the browser never receives generated source-file contents from the fix plan;
- approval uses exact reviewed changed-file paths;
- execution requires an additional explicit confirmation based on the reviewed plan hash;
- fix plans, attempts, correlations and retry authorizations remain immutable artifacts;
- the dashboard still cannot commit, push or merge the target repository.

The dashboard supports `繁體 | English`, System/Light/Dark theme behavior and the existing responsive shell. Changing display language never changes the underlying approval hashes or execution policy.

## Closed-loop state machine

```text
Beta.7 finding
  → explicit selection
  → AI diagnosis/fix plan
  → human review
  → exact source-scope approval
  → exact plan-hash confirmation
  → isolated mutation
  → targeted tests
  → regression
  → Beta.7 QA command
  → awaiting-correlation
  → fresh Beta.7 result comparison
       ├─ resolved + no high regression → completed
       ├─ persistent + retry eligible → rollback partial fix → fresh plan + approval → next bounded attempt
       ├─ new critical/high regression → blocked for human review
       └─ inconclusive / attempt budget exhausted → blocked
```

There is no infinite autonomous repair loop. Every changed fix plan requires separate review/approval, every retry is tied to fresh QA evidence, and the bounded attempt budget remains enforced.
