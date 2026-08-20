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
5. mock-release — mock cleanup/seed strategy and mandatory Beta.7 stage QA.

Suggested stacks are never treated as decisions. `requiresExplicitConfirmation` gates must be answered and confirmed before the future blueprint/code-generation stage may proceed.

Validate an answers JSON array with:

```bash
npm run backend -- validate-interview \
  --interview .qa-backend/architecture-interview.json \
  --answers answers.json
```

The command exits with status 2 until the interview is ready for blueprint generation.

## Next gate

Sprint 3 will convert a validated interview plus discovery evidence into a security blueprint, API/data-model plan, bounded implementation graph, and mock-migration plan. It must still require user approval before mutating a target application.
