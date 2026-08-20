# AI QA Operating System v0.10.0-beta.6

QA-engine reliability release focused on reducing visual false positives without hiding genuine viewport defects, and on keeping accepted baselines/regression memory explicit after classifier changes.

## Visual classifier reliability

- Hidden state is evaluated across the full ancestor chain, including `display:none`, hidden/collapsed visibility, effective opacity, `content-visibility:hidden`, `hidden`, `inert`, and `aria-hidden`.
- Generic `.sidebar` / drawer class names are no longer automatically treated as closed. A visible sidebar with a genuinely unreachable control remains actionable.
- Bootstrap-style `.offcanvas` remains suppressed when closed and is analyzed when explicitly open.
- Disabled and `aria-disabled` controls are excluded from actionable offscreen/overlap checks.
- Controls outside the root viewport but reachable through a horizontally scrollable ancestor are no longer reported as unreachable.
- Intentional `text-overflow: ellipsis` and `-webkit-line-clamp` truncation are no longer classified as text-clipping defects.
- Nested interactive overlap suppression now tracks all interactive ancestors, reducing false overlap reports in composed controls.
- Normal below-fold content remains scroll-reachable and is not treated as a viewport defect.

## Regression coverage

The real-Chromium DOM geometry fixture now verifies all of the following in one field-style regression:

- screen-reader-only content is ignored;
- closed off-canvas content is ignored;
- normal below-fold controls are ignored;
- controls hidden by an opacity-zero ancestor are ignored;
- horizontally scrollable controls remain reachable;
- intentional ellipsis is ignored;
- disabled offscreen controls are ignored;
- a truly unreachable horizontal control is retained;
- a visible generic sidebar with a broken offscreen action is retained.

## Baseline and memory migration

The beta.6 classifier changes the population of deterministic visual findings, so beta.5 accepted state is not silently reused:

- Visual baseline schema is now version 3 with `analyzerVersion: "dom-geometry-v3"`.
- beta.5 version-2 visual baselines are treated as untrusted until explicitly regenerated after a healthy beta.6 run.
- GitHub regression memory is now version 3 while retaining `fingerprintSchema: "finding-v2"` and adding `classifierVersion: "qa-engine-beta6"`.
- beta.5 version-2 regression memory must be explicitly regenerated after confirming beta.6 finding behavior.

This preserves the existing fingerprint algorithm while making the classifier boundary explicit.

## Verified release gates

The prerelease workflow requires:

- tracked-file credential/private-key and unresolved-conflict scans;
- tracked-file 5 MiB ceiling;
- `npm audit --audit-level=high`;
- TypeScript build + full Vitest suite;
- Playwright Chromium installation;
- BrowserExplorer breadth/real-click E2E;
- VisualAgent analysis-provenance E2E;
- expanded DOM-geometry real-browser regression;
- `npm pack --dry-run`;
- tarball creation and SHA-256 checksum.

## Safety posture

- This remains a prerelease.
- Release creation targets the verified beta.6 integration-branch SHA; `main` remains the review/merge surface.
- UX opportunities remain separate from deterministic product defects.
- Baseline and regression-memory writes remain explicit opt-ins and are never silently accepted.
