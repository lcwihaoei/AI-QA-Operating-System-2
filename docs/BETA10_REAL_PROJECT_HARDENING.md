# v0.10.0-beta.10 — Real-project hardening

Beta.10 is an evidence-driven hardening release. It starts from the immutable `v0.10.0-beta.9` prerelease and uses real-project dogfood failures as release criteria instead of adding broad new autonomous capabilities.

## First real-project evidence: LeeEngUI

The first Beta.9 frontend dogfood used LeeEngUI as a React/Vite target and verified the release tag/SHA before execution.

Observed behavior:

- the target's native strict baseline had three pre-existing screenshot-trace artifact assertions; these were preserved as baseline failures rather than attributed to AI-QA;
- linked application routes were explored successfully, while unlinked `/not-found` and wildcard fallback coverage required explicit expansion runs;
- evidence generation was healthy: screenshots, viewport videos and offline report bundles were produced without missing references;
- 124 unique visual findings were reviewed as QA-engine false positives rather than LeeEngUI product defects;
- the dominant false-positive pattern was intentionally tucked/collapsed responsive sidebar content remaining mounted in the DOM;
- Beta.9 governance correctly stopped at the missing fix-model gateway instead of self-approving or mutating the target repository.

## Beta.10 acceptance tracks

### 1. Visual state awareness

Closed/collapsed controlled regions must not create geometry findings merely because their mounted content is intentionally displaced outside the viewport.

The analyzer should prefer explicit state relationships over framework-specific class guessing. In particular, `aria-controls` + `aria-expanded=false` may identify a collapsed controlled region. Suppression is limited to descendants whose own/ancestor geometry is actually displaced; visible controls in the same shell remain analyzable.

Negative controls remain mandatory: genuine visible clipping, overlap and unreachable actions must still be reported.

Tracking: #5, #13.

### 2. Explicit route-manifest coverage

Unlinked but known frontend routes need a bounded, fail-closed route-manifest input. Route values must be normalized, deduplicated, protocol checked and same-origin constrained unless cross-origin navigation was separately enabled.

Static route knowledge is coverage input only. It is not permission to guess application state or bypass authentication/destructive prerequisites.

Tracking: #6.

### 3. Reproducible clean-clone installation

A prerelease tag must support a deterministic clean-clone installation path. Beta.10 should ship a valid lockfile and use the same deterministic install path in CI/release verification that operators use during dogfood.

This repository-level release requirement does not weaken the fix-agent rule that model-authored target-project proposals cannot mutate lockfiles.

Tracking: #7.

### 4. LeeEngUI regression gate

Before Beta.10 is tagged, repeat the LeeEngUI frontend dogfood using the same release profile:

- safe browser exploration;
- API off;
- device off;
- desktop/tablet/mobile visual passes;
- screenshot/video evidence;
- route-family coverage review;
- manual confirmation of medium/high findings;
- governance stop at the model/approval boundary unless a real configured fix provider is present.

The prior 124 offcanvas/sidebar false positives must no longer reproduce. The run must also demonstrate that genuine visible geometry defects are still detectable.

Tracking: #8.

### 5. Preserve Beta.9 governance

Beta.10 must preserve the existing separation between finding selection, fix planning, explicit approval, bounded execution, fresh Beta.7 correlation and attempt-budgeted retry. No hardening change may introduce automatic merge or deploy behavior.

Tracking: #12.

## Release hygiene

The one-shot Beta.9 branch publisher and its release trigger are not part of the long-lived Beta.10 line. The normal verified release workflow remains tag-bound.

Tracking: #10.

## Exit criteria

Beta.10 is release-ready only when:

1. complete TypeScript/Vitest/real-Chromium CI is green;
2. collapsed-controlled-region regressions pass together with genuine-defect negative controls;
3. route-manifest behavior is integrated and tested end to end;
4. a clean clone supports the documented deterministic install path;
5. Beta.9 governance/correlation regressions remain green;
6. LeeEngUI is dogfooded again and the visual false-positive cluster is eliminated without reducing genuine-defect detection;
7. release packaging/checksum/tag-only gates pass on the exact candidate SHA.
