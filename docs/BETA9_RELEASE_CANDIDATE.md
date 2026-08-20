# Beta.9 Release Candidate Checklist

This document records the prerelease packaging boundary for `v0.10.0-beta.9`.

## Candidate metadata

- package version: `0.10.0-beta.9`
- release-manifest version: `0.10.0-beta.9`
- channel: `prerelease`
- release notes: `RELEASE_NOTES.md`
- integration branch: `feature/v0.10.0-beta.9-controlled-auto-fix`
- stacked base: `feature/v0.10.0-beta.8-backend-generation`

## Required verification

Before release approval, the candidate must have a green pull-request CI at the exact candidate HEAD covering:

- TypeScript build and complete Vitest suite;
- real Chromium BrowserExplorer, visual evidence and evidence-report regressions;
- Beta.8 frontend-discovery matrix, architecture interview, security blueprint, controlled executor, mock migration and final Beta.7 QA handoff;
- Beta.9 plan/approval/execute/correlation/retry/fresh-result-discovery workflows;
- Product / Feature Planner HTTP and real Chromium desktop/mobile bilingual regression;
- release metadata consistency.

The verified-release workflow additionally performs repository safety scanning, `npm audit --audit-level=high`, package dry-run, tarball generation and SHA-256 checksum before creating a prerelease.

## Release activation boundary

`release.yml` is intentionally still pinned to the previously verified Beta.7 release branch while Beta.9 remains under review. Do **not** retarget that workflow to the Beta.9 branch as part of ordinary RC preparation: changing the branch filter together with release metadata can activate the release job and create the GitHub prerelease/tag.

Final release activation must therefore be an explicit separate action after operator approval. At that point:

1. confirm the exact Beta.9 candidate HEAD and latest green CI;
2. retarget/prepare the verified-release workflow for the approved Beta.9 release ref;
3. review the workflow diff before any release-triggering push;
4. create/allow the prerelease only from the approved SHA;
5. verify generated `.tgz`, `SHA256SUMS.txt`, tag target and GitHub prerelease metadata;
6. do not merge or deploy unless separately approved.

## Safety boundary

A release candidate may update code, tests, documentation and version metadata on the Beta.9 branch. RC preparation itself must not silently create a tag, GitHub Release, merge, deployment, production migration or external secret change.
