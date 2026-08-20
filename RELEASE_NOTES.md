# AI QA Operating System v0.10.0-beta.9

Beta.9 turns the Beta.7 evidence layer and Beta.8 backend-generation pipeline into a governed development loop: understand an existing frontend, confirm architecture decisions, build bounded backend work, transition mocks safely, run Beta.7 QA, select findings, propose fixes, require approval, execute in isolation, and verify the result with fresh evidence.

## Management dashboard and Product / Feature Planner

The management dashboard now provides a responsive control surface with:

- `繁體 | English` language switching;
- System / Light / Dark appearance;
- desktop sidebar and mobile navigation;
- Dashboard, Findings, Workflows, Tasks, Reports, Beta.8, Beta.9, Settings and Product / Feature Planner surfaces.

Product / Feature Planner converts a product request into an explicit reviewable contract before any source mutation is allowed:

`Opportunity → Decision interview → Alternative selection → Frozen blueprint → Dependency-ordered WorkPlan`

Required product decisions include user outcome, target users, existing-flow compatibility, design-system boundary, data sensitivity and release strategy. Every generated WorkItem starts with source mutation disabled and requires a separate approval/execution workflow.

## Beta.8 frontend-to-backend generation

Beta.8 adds a security-first pipeline for turning an existing frontend into an explicit backend implementation plan:

- bounded frontend discovery for React, Vue, Svelte, Angular, vanilla and additional supported frontend patterns;
- framework, route, form, state, API-candidate, mock/fixture and entity inventory with source evidence and confidence;
- generated/vendor/build directories are skipped, symlinks are not followed, and sensitive key/config material is not read;
- mandatory architecture interview for backend language/framework, API style, database strategy, auth, storage, operations, security and mock/release policy;
- deterministic backend blueprint, security controls, threat-surface mapping, task graph and mock-migration plan;
- human-approved exact source scope before proposal generation;
- exact proposal-hash confirmation before mutation;
- clean checkout and isolated `aiqa/backend/<task>` branch;
- allowlisted targeted/regression/Beta.7 verification commands;
- rollback on failure; successful changes remain reviewable rather than silently merged.

Mock transition is source-by-source and supports retain, rewire-only, convert-to-seed and remove-after-live-verification. Destructive removal requires explicit approval, live-backend verification, exact source/hash guards and QA gates.

## Beta.8 final QA handoff

A Beta.8 implementation cannot be treated as complete only because code generation or local tests succeeded. The final handoff runs Beta.7 evidence-rich QA and records the resulting finding/report summary. Critical/High findings keep the handoff blocked. The resulting Beta.7 evidence can become the source finding set for Beta.9.

## Beta.9 governed AI auto-fix

Beta.9 closes the repair loop without becoming an unrestricted autonomous repair daemon:

`Select findings → Generate fix plan → Review → Approve exact files → Execute → Beta.7 QA → Correlate → Complete or bounded retry`

Key controls:

- only explicitly selected Beta.7 finding fingerprints become work;
- model diagnosis receives bounded source context with probable secrets redacted;
- fix plans include root cause, recommended change, regression risk, confidence, exact file operations and verification commands;
- each plan has an immutable deterministic `planHash`;
- approval scope is separately bound to the WorkItem;
- execution requires the exact reviewed plan plus explicit write acknowledgement;
- default branches are refused and execution runs on isolated `aiqa/fix/<work-item>` branches;
- sensitive/workflow/control-artifact paths are restricted;
- source replacement is SHA-256 guarded;
- targeted tests, regression and Beta.7 QA are required;
- failures roll back; successful changes are not automatically pushed or merged.

## Post-QA correlation and retry budget

A successful QA command is not treated as proof that a finding was fixed. A fresh post-attempt Beta.7 `result.json` is correlated against the source run and classifies the selected finding as persistent, persistent-equivalent, resolved or inconclusive.

Completion requires resolution and no newly introduced Critical/High regression. Persistent findings may receive a bounded retry authorization only while the attempt budget remains. A retry requires a new fix plan and a new approval; the system does not silently reuse the previous plan.

Fresh-result discovery is conservative: stale/source-run results are excluded, symlinked or invalid results are not trusted, exactly one fresh candidate may be auto-selected, and ambiguity blocks correlation instead of guessing.

## Evidence-rich reporting retained from Beta.7

Every normal QA run continues to produce the offline evidence bundle under `.qa-runs/<run-id>/report/`:

- `index.html`;
- `report-data.json`;
- `executive-summary.md`.

Reports retain Executive, Product/UX and Engineering views, screenshots, optional viewport videos, reproduction evidence, regression state, confidence, bounded remediation guidance and explicit `SOURCE_NOT_CONFIRMED` behavior when source attribution is unavailable.

## Release verification gates

The Beta.9 prerelease candidate requires:

- tracked-file credential/private-key, merge-conflict and oversized-file safety scanning;
- high-severity dependency vulnerability gate;
- TypeScript build and complete Vitest suite;
- Playwright Chromium regressions;
- Beta.7 evidence-report/browser/video regressions;
- Beta.8 discovery matrix, architecture, security blueprint, executor, mock migration and final-QA handoff regressions;
- Beta.9 planning, approval, execution, post-QA correlation, retry and fresh-result discovery regressions;
- Product / Feature Planner HTTP, generated-JavaScript and real Chromium desktop/mobile bilingual regressions;
- `npm pack --dry-run` and release artifact SHA-256 generation in the verified-release workflow.

## Safety posture

- This remains a prerelease.
- Planning never grants source mutation by itself.
- Every generated backend or fix mutation requires explicit bounded approval.
- No automatic commit, push, merge or deployment is performed by Beta.8/Beta.9 executors.
- `.qa-*` control/evidence artifacts are reserved and protected from model-generated source changes.
- Probable credentials/tokens/passwords are redacted before remote-model context transmission.
- Fresh Beta.7 evidence determines completion rather than model self-assessment.
- The verified-release workflow remains intentionally separate from ordinary pull-request CI.
