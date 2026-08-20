# Shared Product Planning and Work Items

Beta.8 and Beta.9 must not grow separate, incompatible task systems. This module defines one approval-aware work-item contract that backend generation, future auto-fix, UX opportunities, feature planning, security work and QA can share.

## Work item kinds

`feature`, `bug-fix`, `ux-improvement`, `refactor`, `security`, `backend`, `frontend`, `database`, `qa`, and `infrastructure`.

Each work item records goal/why, evidence, dependencies, affected modules/files, design requirements, implementation plan, security impact, risks, acceptance criteria, tests, QA strategy, confidence and an explicit approval/execution policy.

Mutation is invalid unless all of the following are true:

- the work item requires approval;
- the user/owner has explicitly approved it;
- the approved scope is bound to a scope hash;
- allowed paths are repository-relative and bounded;
- a clean workspace is required;
- execution happens on an isolated branch.

Dependencies must exist and the plan must be acyclic. A dependent work item cannot be approved before its dependencies are completed.

## Product / Feature Planning Mode

A product opportunity can originate from a user request, UX opportunity, QA finding, frontend discovery, or product review. It must include evidence and confidence; the planner may not create a feature plan from an evidence-free suggestion.

A planning session asks explicit questions about:

1. desired user outcome;
2. target users/roles;
3. compatibility with the current flow;
4. preservation of the existing design system;
5. data sensitivity;
6. release/rollout strategy.

The planner offers three bounded alternatives (minimal, balanced, platform-level), but none is treated as selected until the user chooses it. Answers must be valid and explicitly confirmed before a feature blueprint may be created.

A confirmed feature blueprint separates:

- user flow and information architecture;
- frontend requirements;
- backend/data requirements;
- security requirements;
- accessibility and responsive requirements;
- empty/loading/error/permission states;
- analytics boundaries;
- acceptance criteria;
- a dependency-aware work plan.

The generated plan starts with mutation disabled. It is a proposal, not permission to edit a repository.

## Beta.8 adapter

A confirmed Beta.8 backend blueprint can be normalized into the same `WorkPlan` model. This gives the dashboard and future executor one task representation instead of special-casing backend tasks.

## Beta.9 direction

Beta.9 should convert selected Beta.7 findings into the same work-item model before execution. The fix plan, user approval, attempt budget, allowed-path scope and post-fix Beta.7 QA therefore use the same safety gates as feature/backend tasks.
