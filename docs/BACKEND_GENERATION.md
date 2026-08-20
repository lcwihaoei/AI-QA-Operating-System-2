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

Every task starts non-mutating. Before a task can even request a concrete code proposal, a human/operator must approve repository-relative paths. The approval stores a deterministic SHA-256 scope hash over the task definition, verification requirements and allowed paths. Editing the task after approval invalidates that approval.

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

The implementation model then receives only bounded source context and produces a proposal file. Planning does not mutate the repository.

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

If the approved policy requires a Beta.7 QA gate, the operator may provide a reviewed verification command JSON using `--beta7-command`. Model-suggested verification commands are deliberately restricted to test/check/lint/type/build/verify/QA-like invocations; arbitrary shell, `node -e`, Python `-c`, deployment scripts and Git commands are rejected.

Execution safety properties:

- refuses `main`, `master` or `trunk` as the starting branch;
- requires a clean target checkout when the work item says so;
- creates only `aiqa/backend/<task-id>`;
- permits only `create` and SHA-256 guarded `replace` operations in Sprint 4;
- cannot write outside human-approved paths;
- always denies Git internals, GitHub workflows, env/credential/key material and lockfiles;
- no file deletion, mock deletion, seed promotion, commit, push or merge is available;
- targeted verification runs before regression verification;
- required Beta.7 QA runs before a task is marked completed;
- any mutation/verification failure hard-resets, cleans untracked generated files, returns to the original branch and deletes the execution branch;
- a successful task remains on the isolated branch with uncommitted changes for human review.

Proposal approval and scope approval are intentionally separate. A scope approval says where a task may write; `confirm-proposal-hash` confirms the exact reviewed content that will be applied inside that scope.

## Next gate

Sprint 5 will add source-by-source mock migration/seed approval and frontend live-backend rewiring. Destructive mock cleanup must remain impossible until its individual migration record is approved and the corresponding live module has passed targeted verification and Beta.7 QA.
