# v0.10.0-beta.5 hardening

This branch contains QA-engine fixes derived from the LeeEngUI beta.4 field run.

## Fixed in this branch

- MiniMax M3 default request timeout raised to 45s with bounded transient retry/backoff.
- MiniMax JSON extraction now handles `<think>` blocks, fenced JSON, trailing prose and nested structures.
- Empty optional `.env` values are treated as unset instead of failing URL validation.
- Browser probe/synthetic-input failures remain tooling evidence and are excluded from product findings.
- Visual geometry ignores intentionally hidden/off-canvas content and no longer treats normal below-fold controls as viewport defects.
- QA CLI runs compiled JavaScript instead of `tsx` to avoid browser-side `__name` serialization failures.
- Visual baselines use schema v2 (`dom-geometry-v2`) and reject beta.4 baselines after classifier changes.
- GitHub regression memory uses `finding-v2` and rejects beta.4 v1 memory after classifier changes.

## Migration

Regenerate visual and GitHub finding baselines with beta.5. Do not copy beta.4 `.qa-baselines/visual.json` or `.qa-memory/github-findings.json` into a beta.5 run.
