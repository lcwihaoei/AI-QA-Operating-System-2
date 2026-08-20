# Beta.9 — Controlled AI Auto-Fix

Beta.9 closes the loop from a Beta.7 evidence-rich QA report to a reviewed, bounded source change and a fresh Beta.7 verification result. It deliberately separates **selection**, **planning**, **approval**, **execution**, **post-QA correlation**, and **retry authorization** so a model cannot turn a finding into repository mutation by itself.

## 1. Explicit finding selection

Start from a Beta.7 `result.json` and explicitly choose one or more finding fingerprints:

```bash
npm run beta9 -- select \
  --result .qa-runs/<run-id>/result.json \
  --fingerprint <finding-fingerprint> [more...] \
  --project MyProject \
  --out .qa-beta9/plan.json
```

Only selected findings become WorkItems. Every generated WorkItem starts with `mutationAllowed=false` and `approval.approved=false`.

Selection plans are created immutably. The CLI refuses to silently overwrite an existing Beta.9 plan because it may already contain reviewed plans, approvals, correlations, or retry state.

### Optional dashboard-assisted selection

The management dashboard can expose a bounded Beta.7 finding list without exposing raw messages, reproduction steps, or evidence paths:

```bash
npm run dashboard -- \
  --beta7-result .qa-runs/<run-id>/result.json \
  --beta9-plan .qa-beta9/plan.json
```

This mode is read-only by default. To allow the dashboard to create the initial Beta.9 selection plan, the operator must explicitly start a **loopback-only** action mode:

```bash
npm run dashboard -- \
  --host 127.0.0.1 \
  --beta7-result .qa-runs/<run-id>/result.json \
  --beta9-plan .qa-beta9/plan.json \
  --allow-actions
```

`--allow-actions` currently authorizes only creation of a new finding-selection plan. It does **not** authorize source-code mutation, approval, execution, commit, push, or merge. Remote dashboard binding cannot enable this action mode. The POST endpoint requires JSON and rejects browser requests identified as cross-site. Existing Beta.9 plans are never overwritten by dashboard selection.

## 2. AI fix plan — still read-only

The planning phase searches a bounded set of tracked source files using the selected finding's evidence and sends only that bounded context to the configured fix-plan model:

```bash
AIQA_BETA9_TOKEN=... npm run beta9 -- plan-fix \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --repo /path/to/target \
  --model-endpoint https://fix-model-gateway.example/plan
```

The result contains root cause, recommended change, regression risks, confidence, exact create/replace operations, targeted tests, regression verification, a Beta.7 QA command, and a deterministic `planHash` over the complete reviewed plan.

Planning is not permission to write. The WorkItem is enriched with the proposed affected files, implementation steps, risks and tests, but remains non-mutating.

Fix-plan artifacts are immutable. The default filename includes the WorkItem, attempt number and plan-hash prefix, for example:

```text
.qa-beta9/fix-plans/B9-FIX-...-attempt-1-<plan-hash-prefix>.json
```

A retry therefore creates a new reviewed artifact rather than overwriting the prior plan used by an immutable attempt record.

## 3. Human approval binds the exact reviewed plan to repository scope

```bash
npm run beta9 -- approve-fix \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --fix-plan .qa-beta9/fix-plans/<immutable-fix-plan>.json \
  --confirm-plan-hash <sha256> \
  --approved-by owner \
  --allow src/components/** test/**
```

The shared WorkItem system computes a separate scope hash over the task definition and allowed paths. Editing the task after approval makes the scope hash stale. Approval fails when the reviewed code changes are not fully covered by the approved path scope.

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

- refuses to start from `main`, `master`, or `trunk`;
- requires a clean checkout;
- creates an isolated `aiqa/fix/<work-item>` branch;
- supports only bounded create/replace operations;
- never writes outside approved WorkItem paths;
- denies Git internals, workflow files, env/credential/key material and lockfiles;
- replacement writes require the exact SHA-256 of the source reviewed during planning;
- verification commands are restricted to test/check/lint/type/build/verify/QA tooling;
- targeted tests run first, then regression verification, then Beta.7 QA;
- mutation/verification failures roll back and mark the WorkItem blocked;
- successful source changes remain uncommitted on the isolated branch;
- every attempt emits an immutable attempt record;
- each WorkItem has a bounded attempt budget (default 3).

A successful Beta.7 command exit code does **not** mark the WorkItem complete. It moves to `verification` and the attempt outcome becomes `awaiting-correlation` until a fresh Beta.7 result is compared with the original run.

## 5. Post-QA correlation

After the execution's Beta.7 command produces a new `result.json`, correlate the exact attempt against both the source and fresh reports:

```bash
npm run beta9 -- correlate \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --before-result .qa-runs/<source-run>/result.json \
  --after-result .qa-runs/<post-run>/result.json \
  --attempt-record .qa-beta9/attempts/<attempt>.json
```

Correlation is conservative:

- `persistent` — exact selected fingerprint remains;
- `persistent-equivalent` — fingerprint changed, but one same-kind/same-route/same-title finding remains;
- `resolved` — exact fingerprint and equivalent finding are both absent;
- `inconclusive` — multiple equivalent findings prevent safe automatic classification.

The report also counts findings newly introduced after the attempt. A new critical/high finding blocks automatic retry. The correlation report has its own deterministic `correlationHash` and is written immutably.

Only `resolved` with no new critical/high regression marks the WorkItem `completed`.

## 6. Bounded retry authorization

A retry is permitted only when all of these are true:

- the previous immutable attempt record exists and matches the correlation;
- the fresh Beta.7 result still shows the selected finding as `persistent` or `persistent-equivalent`;
- no new critical/high regression appeared;
- the previous attempt is inside the WorkItem attempt budget;
- the previous attempt outcome is eligible for correlation/retry.

Prepare the retry:

```bash
npm run beta9 -- prepare-retry \
  --plan .qa-beta9/plan.json \
  --correlation .qa-beta9/correlations/<correlation>.json \
  --attempt-record .qa-beta9/attempts/<attempt>.json \
  --repo /path/to/target
```

If the previous attempt left successful-but-unresolved uncommitted changes on its isolated branch, `prepare-retry` requires that exact execution branch to be checked out and rolls it back to the recorded original branch before authorizing a new attempt. This prevents retries from silently stacking unreviewed partial fixes.

The retry authorization:

- is bound to the WorkItem, selected finding, source run, fresh post run, prior attempt number and correlation hash;
- authorizes exactly `previousAttempt + 1`;
- resets the WorkItem to non-mutating `planned` state;
- clears the previous allowed path scope and approval;
- requires a completely new immutable fix plan and a new human scope approval.

Retry planning receives the fresh post-QA authorization context, including prior/next attempt, source/post run and correlation hash. The provider is explicitly instructed not to repeat the prior failed approach without new evidence.

Attempt 2+ execution must also confirm the exact retry authorization hash:

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

The authorization is consumed when the retry begins. Attempt numbers above 1 cannot bypass this gate.

## Closed-loop state machine

```text
Beta.7 finding
  → explicit selection
  → AI diagnosis/fix plan
  → human review
  → WorkItem scope approval
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

There is no infinite autonomous repair loop. Every new fix plan requires separate review/approval, every retry is tied to fresh QA evidence, and the maximum attempt budget remains enforced.
