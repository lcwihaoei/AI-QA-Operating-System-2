# Beta.8 Sprint 4 — Controlled Executor

## Goal

Convert approved WorkItems into bounded execution attempts without allowing planning output to become automatic repository mutation.

## Execution lifecycle

```text
WorkPlan
  ↓
Dependency validation
  ↓
Approval validation
  ↓
Scope hash verification
  ↓
Isolated workspace
  ↓
One task execution
  ↓
Targeted tests
  ↓
Regression tests
  ↓
Beta.7 evidence QA
  ↓
Accept / rollback
```

## Mandatory gates

An executor MUST reject execution when:

- dependency tasks are incomplete;
- approval is missing;
- approved scope differs from execution scope;
- allowed paths are not repository-relative;
- workspace is dirty;
- branch isolation is unavailable;
- required tests are missing;
- Beta.7 QA evidence is skipped.

## Attempt model

Each execution creates an immutable attempt record:

- workItemId
- scopeHash
- executorVersion
- startedAt
- changedFiles
- commandsExecuted
- testResults
- evidenceReferences
- rollbackState

## Rollback policy

Failed attempts never continue silently. The executor must preserve the failure evidence, restore the workspace, and return the WorkItem to a retryable state.

## Beta.9 integration

Beta.9 auto-fix will consume the same executor. A finding becomes:

QA Finding → WorkItem → Fix Proposal → User Approval → Controlled Execution → Beta.7 Regression Report

No separate autonomous fixer path will be created.
