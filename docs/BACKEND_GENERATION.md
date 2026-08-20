# Beta.8 Frontend-to-Backend Generation

Beta.8 treats backend generation as a gated engineering workflow, not a one-shot code-completion task.

## Sprint 2: discovery and architecture interview

The discovery engine is deliberately language-neutral at the filesystem boundary and uses bounded adapters/heuristics for common frontend ecosystems. It inventories routes, forms, state mechanisms, API calls, mock/fixture sources, framework signals, and entity candidates while preserving evidence paths.

Safety rules:

- generated/vendor/build directories are skipped;
- symlinks are not followed;
- `.env`, private keys, credential/secret-like files and keystores are not read;
- source files are bounded by count and per-file byte limits;
- absolute local paths and source bodies are not written into the discovery report;
- hitting a file limit produces an explicit incomplete-discovery question rather than a false completeness claim.

Run locally:

```bash
npm run backend -- discover --repo /path/to/frontend --out .qa-backend
```

Outputs:

```text
.qa-backend/
├── frontend-discovery.json
└── architecture-interview.json
```

The architecture interview has five rounds:

1. project-understanding — confirm that the discovered surface is the intended product boundary;
2. backend-stack — language/runtime, framework, deployment target;
3. data-auth — database, authentication, authorization, sensitive-data classification;
4. security-operations — mandatory controls and external integration/storage/realtime constraints;
5. mock-release — mock cleanup/seed strategy and Beta.7 stage QA policy.

Suggested stacks are never treated as decisions. `requiresExplicitConfirmation` gates must be answered and confirmed before blueprint/code-generation stages may proceed.

Validate an answers JSON array with:

```bash
npm run backend -- validate-interview \
  --interview .qa-backend/architecture-interview.json \
  --answers answers.json
```

The command exits with status 2 until the interview is ready for blueprint generation.

## Sprint 3: security-first blueprint

After all required interview answers are valid and explicitly confirmed:

```bash
npm run backend -- blueprint \
  --discovery .qa-backend/frontend-discovery.json \
  --interview .qa-backend/architecture-interview.json \
  --answers answers.json \
  --out .qa-backend/backend-blueprint.json
```

The blueprint contains a minimum non-negotiable security baseline, threat-surface items, inferred API/data-model plans, a bounded dependency-aware implementation graph, and per-mock migration proposals. Blueprint generation still sets `executionGate.approved=false`; it cannot grant itself permission to mutate the target repository.

## Sprint 4: approval-bound controlled executor

Turn a confirmed blueprint into the shared work-item format:

```bash
npm run backend -- work-plan \
  --blueprint .qa-backend/backend-blueprint.json \
  --out .qa-backend/work-plan.json
```

Every task starts non-mutating. Before a task can request a concrete code proposal, a human/operator must approve repository-relative paths. The approval stores a deterministic SHA-256 scope hash over the task definition, verification requirements and allowed paths. Editing the task after approval invalidates that approval.

```bash
npm run backend -- approve-task \
  --plan .qa-backend/work-plan.json \
  --item B8-FND-001 \
  --approved-by owner \
  --allow backend/**
```

For workflows that want the hash reviewed before approval:

```bash
npm run backend -- scope-hash \
  --plan .qa-backend/work-plan.json \
  --item B8-FND-001 \
  --allow backend/**
```

The implementation model receives bounded source context and produces a proposal file. Planning does not mutate the repository.

```bash
AIQA_BACKEND_TOKEN=... npm run backend -- propose-task \
  --plan .qa-backend/work-plan.json \
  --item B8-FND-001 \
  --repo /path/to/target \
  --model-endpoint https://backend-model-gateway.example/propose
```

The proposal has its own deterministic `proposalHash`. Execution requires the exact reviewed hash plus a separate `--confirm-write` acknowledgement:

```bash
npm run backend -- execute-task \
  --plan .qa-backend/work-plan.json \
  --item B8-FND-001 \
  --repo /path/to/target \
  --proposal .qa-backend/proposals/B8-FND-001.json \
  --confirm-proposal-hash <sha256> \
  --confirm-write
```

If the approved policy requires a Beta.7 QA gate, the operator provides a reviewed verification command JSON using `--beta7-command`. Model-suggested verification commands are restricted to test/check/lint/type/build/verify/QA-like invocations; arbitrary shell, `node -e`, Python `-c`, deployment scripts and Git commands are rejected.

Execution safety properties:

- refuses `main`, `master` or `trunk` as the starting branch;
- requires a clean target checkout when the work item says so;
- creates only `aiqa/backend/<task-id>`;
- permits only `create` and SHA-256 guarded `replace` operations in Sprint 4;
- cannot write outside human-approved paths;
- always denies Git internals, GitHub workflows, env/credential/key material and lockfiles;
- no general-purpose file deletion, commit, push or merge is available;
- targeted verification runs before regression verification;
- required Beta.7 QA runs before a task is marked completed;
- any mutation/verification failure hard-resets, cleans untracked generated files, returns to the original branch and deletes the execution branch;
- a successful task remains on the isolated branch with uncommitted changes for human review;
- each execution writes an immutable attempt record containing scope/proposal hashes, changed paths, verification commands/results, Beta.7 evidence and rollback outcome.

Proposal approval and scope approval are intentionally separate. A scope approval says where a task may write; `confirm-proposal-hash` confirms the exact reviewed content that will be applied inside that scope.

## Sprint 5: source-by-source mock migration and live-backend transition

Mock cleanup is not delegated to the general executor. Beta.8 builds a dedicated migration plan from the discovery/blueprint evidence so every mock source receives its own explicit decision:

```bash
npm run backend -- mock-plan \
  --blueprint .qa-backend/backend-blueprint.json \
  --out .qa-backend/mock-migration-plan.json
```

Supported decisions are:

- `retain` — keep the mock intentionally;
- `rewire-only` — move the frontend to the verified live backend but do not let the migration executor delete the source file;
- `convert-to-seed` — copy reviewed demo data into an explicitly approved seed destination, optionally removing the exact file-based source afterwards;
- `remove-after-live-verification` — remove one exact file-based mock source only after the live replacement has been verified.

Approve one source at a time:

```bash
npm run backend -- approve-mock \
  --plan .qa-backend/mock-migration-plan.json \
  --record MOCK-... \
  --approved-by owner \
  --action convert-to-seed \
  --seed-destination backend/seeds/users.json \
  --remove-source-after-seed
```

Each approval is bound to a deterministic decision hash. Changing the source, selected action, seed destination, deletion choice or QA requirements makes the approval stale.

### Live-backend gate

Destructive migration and seed promotion are blocked until an operator-reviewed live-backend verification command passes:

```bash
npm run backend -- verify-mock-live \
  --plan .qa-backend/mock-migration-plan.json \
  --record MOCK-... \
  --repo /path/to/target \
  --command .qa-backend/commands/verify-live-users.json
```

`inline-mock` and `mock-library` findings can never authorize whole-file deletion. They use `rewire-only` and must be cleaned later through a bounded, source-aware frontend WorkItem rather than deleting a component or shared library because it happened to contain mock code.

For `retain` and `rewire-only`, no dedicated mock-file mutation is required. `rewire-only` still requires live verification and a Beta.7 gate before its migration record can be completed:

```bash
npm run backend -- complete-mock-no-mutation \
  --plan .qa-backend/mock-migration-plan.json \
  --record MOCK-... \
  --repo /path/to/target \
  --beta7-command .qa-backend/commands/beta7.json
```

### Reviewed seed/removal proposal

For an approved file-based `convert-to-seed` or `remove-after-live-verification` record that has passed the live gate:

```bash
AIQA_MOCK_MIGRATION_TOKEN=... npm run backend -- propose-mock \
  --plan .qa-backend/mock-migration-plan.json \
  --record MOCK-... \
  --repo /path/to/target \
  --model-endpoint https://backend-model-gateway.example/mock-migration
```

The model receives only the exact approved source plus the optional approved seed destination. Probable credentials/tokens/passwords are redacted before provider transmission. The proposal may touch only those paths and has its own deterministic `proposalHash`.

Execution requires explicit confirmation of that exact proposal:

```bash
npm run backend -- execute-mock \
  --plan .qa-backend/mock-migration-plan.json \
  --record MOCK-... \
  --repo /path/to/target \
  --proposal .qa-backend/mock-proposals/MOCK-....json \
  --confirm-proposal-hash <sha256> \
  --confirm-write
```

Mock-migration safety properties:

- live-backend verification must precede destructive operations;
- source deletion is SHA-256 guarded and restricted to the exact approved file;
- seed creation/replacement is restricted to the exact approved destination;
- source replacement is not allowed in the mock migration executor;
- arbitrary paths, secret material, Git internals and workflow files are outside scope;
- targeted tests, regression verification and Beta.7 QA all must pass;
- failure restores deleted sources, removes newly created seed files, returns to the original branch and deletes the migration branch;
- success remains on `aiqa/mock/<record-id>` with uncommitted changes for human review;
- CLI execution writes an immutable migration attempt record.

Frontend API rewiring remains a normal approved `B8-INT-001`/frontend WorkItem so the code change that swaps mock clients for live clients is reviewable independently from data deletion. This prevents “backend is ready” from being treated as permission to erase unrelated mock code.

## Next gate

After Sprint 5 is verified, Beta.9 can consume Beta.7 findings through the same shared WorkItem, approval, proposal-hash, bounded executor and Beta.7 regression gates. The management dashboard will expose those states instead of creating a separate unrestricted auto-fix path.
