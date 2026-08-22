# AI QA Operating System v0.10.0-beta.7

Reliability follow-up that ships the complete post-field-validation hardening set after the immutable `v0.10.0-beta.6` tag had already been created before the final fixes landed. This release is the recommended successor to beta.6.

## Visual classifier reliability

- Hidden state is evaluated across the full ancestor chain, including `display:none`, hidden/collapsed visibility, effective opacity, `content-visibility:hidden`, `hidden`, `inert`, and `aria-hidden`.
- Closed CSS off-canvas navigation is detected beyond Bootstrap `.offcanvas`, including translated mobile menus and negative-inset fixed/absolute drawers.
- Drawer/sidebar semantics are restricted to container-like elements so ordinary controls whose ids happen to contain words such as `sidebar` are not incorrectly suppressed.
- Explicitly open panels (`show`/`open`/`active`, `data-state=open`, `data-open=true`, or `aria-hidden=false`) remain analyzable; genuine unreachable controls inside them are still findings.
- Disabled and `aria-disabled` controls are excluded from actionable offscreen/overlap checks.
- Controls outside the root viewport but reachable through a horizontally scrollable ancestor are no longer reported as unreachable.
- Intentional `text-overflow: ellipsis` and `-webkit-line-clamp` truncation are no longer classified as text-clipping defects.
- Nested interactive overlap suppression tracks all interactive ancestors, reducing false overlap reports in composed controls.
- Normal below-fold content remains scroll-reachable and is not treated as a viewport defect.

## Exploration reliability and coverage

Beta.5 field validation showed that reserving at most three non-link interactions per page could leave complex frontends with only a few percent interaction coverage. The current selector keeps route-family breadth while expanding deterministic safe interaction capacity:

- safe interactions may use up to 45% of the per-page candidate budget, capped at eight slots;
- at least one safe button and one safe field are preferred when present;
- top-level route-family diversification remains in place before deeper navigation fills unused capacity;
- deterministic risk policy is unchanged, so increasing interaction coverage does not unlock blocked/destructive actions.

Browser probe failures and synthetic-input failures remain diagnostic events but are filtered from product findings by the reporter and therefore do not inflate product severity or GitHub regression findings.

## Evidence storage

Large Vite/SPA runs can produce highly repetitive HAR files approaching gigabyte scale. Oversized completed HAR evidence is now compacted after browser shutdown:

- `network.har` files at or above 5 MB are gzip-compressed to `network.har.gz`;
- the original uncompressed HAR is removed only after successful compression;
- small HAR files are left untouched;
- HAR compaction failure never blocks `result.json` generation.

This reduces persistent evidence storage without weakening browser/network error events in `events.json`.

## Regression coverage

Real-Chromium and deterministic regressions verify:

- screen-reader-only content is ignored;
- closed negative-inset off-canvas content is ignored;
- transform-translated closed mobile navigation is ignored;
- negative-right closed drawers are ignored;
- normal below-fold controls are ignored;
- controls hidden by an opacity-zero ancestor are ignored;
- horizontally scrollable controls remain reachable;
- intentional ellipsis is ignored;
- disabled offscreen controls are ignored;
- a truly unreachable horizontal control is retained;
- an explicitly open generic sidebar with a broken offscreen action is retained;
- expanded interaction quota still preserves route breadth and blocked-candidate exclusion;
- oversized HAR evidence is compressed while small HAR evidence remains intact.

## Baseline and memory migration

The beta.6 classifier boundary remains authoritative for beta.7:

- Visual baseline schema is version 3 with `analyzerVersion: "dom-geometry-v3"`.
- beta.5 version-2 visual baselines are untrusted until explicitly regenerated after a healthy beta.6+ run.
- GitHub regression memory is version 3 while retaining `fingerprintSchema: "finding-v2"` and `classifierVersion: "qa-engine-beta6"`.
- beta.5 version-2 regression memory must be explicitly regenerated after confirming the new classifier behavior.

## Verified release gates

The prerelease workflow requires:

- tracked-file credential/private-key and unresolved-conflict scans;
- tracked-file 5 MiB ceiling;
- `npm audit --audit-level=high`;
- TypeScript build + full Vitest suite;
- Playwright Chromium installation;
- BrowserExplorer breadth/real-click E2E;
- interaction-budget regression tests;
- HAR-compaction regression tests;
- tooling-probe finding filtering;
- VisualAgent analysis-provenance E2E;
- expanded DOM-geometry real-browser regressions for hidden/off-canvas/below-fold/scrollable/intentional-truncation/open-sidebar cases;
- `npm pack --dry-run`;
- tarball creation and SHA-256 checksum.

## Safety posture

- This remains a prerelease.
- The existing `v0.10.0-beta.6` tag is not rewritten; beta.7 carries the complete verified follow-up code.
- Release creation targets the verified beta.7 branch SHA; `main` remains the review/merge surface until explicitly merged.
- UX opportunities remain separate from deterministic product defects.
- Baseline and regression-memory writes remain explicit opt-ins and are never silently accepted.
