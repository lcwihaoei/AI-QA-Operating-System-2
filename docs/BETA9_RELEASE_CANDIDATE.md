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

`release.yml` is tag-bound. Ordinary branch pushes cannot create the prerelease. The release workflow activates only for a `v0.10.0-beta.*` tag and then independently verifies that:

- `release-manifest.json` and `package.json` have the same version;
- the channel is `prerelease`;
- the pushed tag is exactly `v<manifest version>`;
- the release-notes heading matches the exact tag;
- all release safety, dependency, build/test, real-browser and packaging gates pass.

Final release activation must therefore remain an explicit separate action after operator approval. At that point:

1. confirm the exact Beta.9 candidate HEAD and latest green pull-request CI;
2. review the final release metadata and release-workflow diff;
3. create `v0.10.0-beta.9` only on the approved candidate SHA;
4. allow the tag-triggered verified-release workflow to finish;
5. verify generated `.tgz`, `SHA256SUMS.txt`, tag target and GitHub prerelease metadata;
6. do not merge or deploy unless separately approved.

## Safety boundary

A release candidate may update code, tests, documentation, version metadata and release automation on the Beta.9 branch. RC preparation itself must not silently create a tag, GitHub Release, merge, deployment, production migration or external secret change.
