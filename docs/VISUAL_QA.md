# Visual QA

M3 adds a dedicated visual layer after browser exploration. It intentionally starts from deterministic DOM geometry rather than treating screenshot pixel differences as defects.

## Viewport profiles

The CLI accepts a comma-separated visual matrix:

```bash
npm run qa -- \
  --url https://example.com \
  --visual-viewports desktop,mobile
```

Available profiles:

| Profile | Size |
| --- | --- |
| `desktop` | 1440×1000 |
| `tablet` | 768×1024 |
| `mobile` | 390×844 |

The default is `desktop,mobile`. Duplicate names are removed while preserving request order.

## Session-state bridge

Before the exploratory browser context closes, Playwright's storage state is captured in memory. `QaManager` passes that object directly to responsive Visual Agent contexts so cookies and origin local-storage state can be reused for authenticated pages.

The storage-state object is intentionally **not** added to `QaRunResult`, `events.json` or `result.json`, and the bridge does not persist a storage-state file. Visual telemetry records only a boolean `sessionStateReused` flag.

This improves authenticated visual fidelity without turning QA evidence into a credential archive. Session storage and application-specific in-memory state may still require later state-replay strategies.

## Deterministic geometry signals

`DomGeometryAnalyzer` can report:

- whole-document horizontal overflow
- interactive controls outside or horizontally cut off by the viewport
- visible text clipped by computed overflow geometry
- substantial overlap between independent interactive controls

Each signal records the viewport, element description, rectangles and a screenshot when a visual defect exists. Desktop/tablet/mobile messages remain distinct so the bug deduplicator does not collapse breakpoint-specific defects.

## Optional screenshot evidence provider

By default, screenshots remain local evidence only. If `AIQA_VISUAL_ENDPOINT` (or `--visual-endpoint`) is explicitly configured, Visual Agent can send only screenshots that already have deterministic geometry signals to an AIQA visual evidence gateway.

```bash
export AIQA_VISUAL_ENDPOINT=https://vision.example.internal/v1/assess
export AIQA_VISUAL_TOKEN=...

npm run qa -- --url https://example.com
```

Non-loopback endpoints must use HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.1` or loopback IPv6. This policy is enforced inside the HTTP provider itself, not only by the CLI.

The request contains the URL, viewport, deterministic signals and a PNG screenshot encoded as base64. Screenshots larger than 8 MiB are rejected before transmission. Storage state, cookies and tokens are never included in the visual-provider payload.

The gateway returns bounded evidence assessments:

```json
{
  "assessments": [
    {
      "signalIndex": 0,
      "verdict": "confirm",
      "confidence": 0.96,
      "reason": "The mobile Save button visibly overlaps the footer control"
    }
  ]
}
```

Allowed verdicts are `confirm`, `reject` and `uncertain`. A strong `reject` (confidence >= 0.85) can downgrade a geometry finding from medium to low, but never delete it. A provider cannot promote a geometry signal above the deterministic layer's severity ceiling. Invalid indexes are ignored and confidence is clamped.

Provider timeouts, invalid responses and other failures fall back to geometry-only behavior and are recorded as telemetry rather than product defects.

## Deterministic visual-regression baseline

The default baseline path is `.qa-baselines/visual.json` and can be changed with `--visual-baseline` or `AIQA_VISUAL_BASELINE`.

The baseline stores normalized **visual signal metadata only**. It does not store screenshots, cookies, storage state, tokens or form values. Each entry is keyed from:

- normalized URL path
- viewport profile
- visual signal kind
- normalized primary/related element descriptions
- normalized deterministic message

Numeric path segments, UUID-like segments and dynamic numbers inside element/message text are normalized so ordinary IDs and counters do not create unnecessary baseline churn.

If the baseline exists, current signals are classified as:

- `persistent` — still present and already accepted in the baseline
- `new` — not present in the accepted baseline
- `resolved` — present in the baseline but no longer observed

If no baseline exists, current signals are `untracked`; the system does not pretend every first-run signal is a regression.

Normal runs are **read-only** with respect to the baseline. The manifest is replaced only when `--update-visual-baseline` is explicitly provided:

```bash
npm run qa -- \
  --url https://example.com \
  --visual-baseline .qa-baselines/visual.json \
  --update-visual-baseline
```

This explicit update rule is a safety boundary: an autonomous QA run must not silently accept a newly introduced defect as the new normal. Teams can commit the manifest so CI, developers and later regression runs share the same accepted state.

## Severity boundary

Geometry-only signals are limited to `medium` or lower severity. Screenshot evidence currently refines confidence but cannot self-promote a finding to `high`. A baseline state also does not independently raise severity. Later multi-source evidence policies can raise severity only through an explicit QA policy rather than trusting one vision model or one historical manifest.

## Tooling failures

Visual navigation/analyzer/provider/baseline failures are telemetry, not product defects. This avoids reporting infrastructure, state-replay, model-provider or baseline-storage failures as application bugs.
