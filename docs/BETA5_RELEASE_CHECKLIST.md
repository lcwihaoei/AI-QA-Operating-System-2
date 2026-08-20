# v0.10.0-beta.5 release checklist

The beta.5 release is permitted only after the hardening branch passes:

- TypeScript build
- full Vitest suite
- Playwright Chromium installation
- BrowserExplorer real-browser regression
- VisualAgent provenance regression
- DOM geometry hidden/offcanvas/below-fold regression
- MiniMax retry/JSON extraction tests
- MiniMax planner redaction test
- MiniMax UX aggregate-only reasoner test
- dependency audit (high severity gate)
- npm pack dry-run and SHA-256 artifact generation

No merge to `main` is part of this release flow. The verified prerelease is produced from the integration branch after the hardening branch is validated.
