# AI QA Operating System v0.10.0-beta.5

Field-validation hardening release based on the real LeeEngUI Stage 17 deep QA run against beta.4. This release focuses on QA-engine correctness: MiniMax reliability, visual false-positive reduction, tooling/product-error separation, compiled runtime stability, and explicit baseline/memory migration after classifier changes.

## MiniMax M3 reliability

- Default per-attempt timeout is now 45 seconds instead of the beta.4 15-second window.
- `MINIMAX_TIMEOUT_MS` can tune the timeout (1,000–180,000 ms).
- Transient network/timeout, HTTP 408/429 and 5xx responses receive up to three bounded retries by default; `MINIMAX_RETRY_ATTEMPTS` supports 1–5 attempts.
- Non-retryable 4xx responses are not retried.
- Retry backoff is exponential and capped.
- Structured response extraction now removes `<think>...</think>` and Markdown fences and finds balanced nested JSON while respecting quoted braces and escapes.
- MiniMax planner context is reduced to bounded paths, page counters, compact coverage data and at most 60 candidates; raw page body samples are not sent.
- MiniMax UX reasoning receives aggregate page metrics only, capped to 30 page snapshots and 16 deterministic opportunities.
- Call telemetry internally tracks attempts, latency and canonical model ID.

## Visual QA precision

The beta.4 LeeEngUI run showed that many reported visual findings were intentional states rather than product defects. beta.5 changes the deterministic classifier so that:

- `.visually-hidden`, `.sr-only`, `.screen-reader-text`, hidden/inert/ARIA-hidden content is excluded from visual clipping/offscreen analysis;
- closed off-canvas/drawer/sidebar states are excluded unless they are explicitly open;
- controls below the fold on normal long pages are no longer classified as viewport defects simply because `y > viewport height`;
- genuinely horizontally unreachable/clipped controls and above-viewport controls remain actionable signals.

A new real-Chromium regression fixture proves the classifier ignores visually-hidden, closed off-canvas and normal below-fold controls while retaining a genuine horizontal defect.

## Product finding hygiene

- Button probe timeouts and synthetic field/select exercise failures are classified as QA tooling evidence rather than product findings.
- These tooling failures no longer inflate High severity counts, GitHub issue plans or regression memory.
- Genuine uncaught browser page errors remain High severity.

## Runtime/configuration stability

- `npm run qa` now builds first and runs `node dist/src/cli.js` instead of executing the QA browser path through `tsx`. This avoids the esbuild/tsx `keepNames` `__name` helper leaking into Playwright browser-evaluated functions.
- Empty optional `.env` assignments such as `AIQA_VISUAL_ENDPOINT=` and `AIQA_UX_ENDPOINT=""` are treated as unset, preventing URL-schema failures.
- Existing exported environment variables still take precedence over `.env` values.

## Baseline and regression-memory migration

The visual classifier and finding population changed materially, so beta.5 does not silently compare against beta.4 state:

- Visual baseline schema is now version 2 with `analyzerVersion: "dom-geometry-v2"` and mandatory successful `analyzedStates` provenance.
- beta.4 version-1 visual baselines are treated as untrusted and must be regenerated.
- GitHub finding regression memory is now version 2 with `fingerprintSchema: "finding-v2"`.
- beta.4 version-1 GitHub finding memory is not trusted after tooling-finding removal and must be explicitly regenerated.

Do **not** copy beta.4 `.qa-baselines/visual.json` or `.qa-memory/github-findings.json` into a beta.5 run. Run beta.5 once without accepting a baseline, verify healthy coverage/provenance, then explicitly update the new baseline/memory.

## Regression coverage added

- MiniMax M3 endpoint/model normalization
- transient retry and non-retryable 4xx behavior
- nested/fenced/`<think>` JSON extraction
- MiniMax planner secret/query/body-sample minimization
- MiniMax aggregate-only UX reasoner path
- empty optional `.env` endpoints
- browser tooling-failure exclusion from product findings
- below-fold vs horizontal offscreen geometry
- real Chromium visually-hidden/off-canvas/below-fold regression
- compiled QA runtime entrypoint
- visual baseline v2 provenance/migration
- GitHub regression memory v2 migration boundary

## Verified release gates

The release workflow requires:

- tracked-file credential/private-key and unresolved-conflict scans;
- tracked-file 5 MiB ceiling;
- `npm audit --audit-level=high`;
- TypeScript build + full Vitest suite;
- Playwright Chromium installation;
- BrowserExplorer breadth/real-click E2E;
- VisualAgent analysis-provenance E2E;
- DOM geometry hidden/off-canvas/below-fold real-browser E2E;
- `npm pack --dry-run`;
- tarball creation and SHA-256 checksum.

## Safety posture

- This remains a prerelease.
- The release is produced from the integration branch; `main` is not modified by the beta.5 hardening flow.
- UX opportunities remain distinct from deterministic product defects.
- Baseline/learning writes remain explicit opt-ins.
