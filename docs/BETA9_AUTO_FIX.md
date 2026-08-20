# Beta.9 — Controlled AI Auto-Fix

Beta.9 closes the loop from a Beta.7 evidence-rich QA report to a reviewed, bounded source change and a new Beta.7 verification run. It deliberately separates **selection**, **planning**, **approval**, **execution**, and **verification** so a model cannot turn a finding into repository mutation by itself.

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

## 2. AI fix plan — still read-only

The planning phase searches a bounded set of tracked source files using the selected finding's title/message evidence and sends only that bounded context to the configured fix-plan model:

```bash
AIQA_BETA9_TOKEN=... npm run beta9 -- plan-fix \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --repo /path/to/target \
  --model-endpoint https://fix-model-gateway.example/plan
```

The result contains:

- finding fingerprint;
- root-cause explanation;
- recommended change steps;
- regression risks;
- confidence;
- exact source create/replace operations with SHA-256 guards for replacements;
- targeted verification commands;
- broader regression verification;
- mandatory Beta.7 QA command;
- deterministic `planHash` over the complete reviewed plan.

Planning is not permission to write. The WorkItem is enriched with the proposed affected files, implementation steps, risks and tests, but remains non-mutating.

## 3. Human approval binds the exact reviewed plan to repository scope

After reviewing the root cause, code changes, risks and tests, approve the WorkItem and bounded repository-relative paths:

```bash
npm run beta9 -- approve-fix \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --fix-plan .qa-beta9/fix-plans/B9-FIX-....json \
  --confirm-plan-hash <sha256> \
  --approved-by owner \
  --allow src/components/** test/**
```

The shared WorkItem system computes a separate scope hash over the task definition and allowed paths. If the task is edited later, the approval becomes stale. Approval also fails when the reviewed code changes are not fully covered by the approved path scope.

## 4. Controlled execution

Execution requires another explicit write acknowledgement and confirmation of the exact fix-plan hash:

```bash
npm run beta9 -- execute-fix \
  --plan .qa-beta9/plan.json \
  --item B9-FIX-... \
  --repo /path/to/target \
  --fix-plan .qa-beta9/fix-plans/B9-FIX-....json \
  --confirm-plan-hash <sha256> \
  --attempt 1 \
  --confirm-write
```

Safety properties:

- refuses to start from `main`, `master`, or `trunk`;
- requires a clean checkout;
- creates an isolated `aiqa/fix/<work-item>` branch;
- supports only bounded create/replace operations in the initial Beta.9 executor;
- never writes outside the approved WorkItem paths;
- always denies Git internals, workflow files, env/credential/key material and lockfiles;
- replacement writes require the exact SHA-256 of the source that was reviewed during planning;
- verification commands are restricted to test/check/lint/type/build/verify/QA tooling and cannot execute arbitrary shell, deploy, Git, `node -e`, or Python `-c` commands;
- targeted tests run first, then broader regression verification, then Beta.7 QA;
- any failure rolls the workspace back and marks the WorkItem blocked;
- success leaves reviewed changes uncommitted on the isolated branch;
- every attempt emits an immutable record containing hashes, changed paths, commands/results, evidence references, rollback state, and outcome;
- each WorkItem has a bounded attempt budget (default 3).

## Closed-loop direction

This initial Beta.9 slice establishes the safe common path:

```text
Beta.7 finding
  → explicit selection
  → AI diagnosis/fix plan
  → human review
  → WorkItem scope approval
  → exact plan-hash confirmation
  → isolated mutation
  → targeted regression
  → broader regression
  → Beta.7 QA
  → verified / rolled back
```

The next Beta.9 sprint adds post-QA finding correlation and retry orchestration. A retry will only be permitted when the previous immutable attempt and new Beta.7 report are available, the WorkItem remains inside its attempt budget, and the new fix plan is separately reviewed/approved. No infinite autonomous repair loop is permitted.
