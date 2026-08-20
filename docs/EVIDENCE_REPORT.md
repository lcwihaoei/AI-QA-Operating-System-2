# Evidence-rich QA reports (v0.10.0-beta.7)

Beta.7 turns a QA run into a portable review bundle for engineering, product and UX. The report is generated locally from the same deterministic evidence used by `result.json`; it does not create or mutate external issues.

## Output bundle

Every normal QA run now writes:

```text
.qa-runs/<run-id>/
├── events.json
├── result.json
├── network.har
├── screenshots/
├── videos/                    # populated only with --record-video
├── ux-opportunities.json      # when UX intelligence is enabled
└── report/
    ├── index.html
    ├── report-data.json
    └── executive-summary.md
```

`report/index.html` is self-contained except for relative links to evidence in the same run directory, so the run directory can be copied as one review package and opened offline.

## Run with video evidence

```bash
npm run qa -- \
  --url https://staging.example.com \
  --visual-viewports desktop,tablet,mobile \
  --record-video
```

The visual agent records one Playwright video per requested viewport. Findings link to the matching viewport recording when one exists. Video capture is opt-in because it increases storage use and may record on-screen content.

Disable report generation entirely with:

```bash
npm run qa -- --url https://staging.example.com --no-evidence-report
```

## Report views

The HTML report includes three reading modes:

- **Executive** — verdict, coverage, severity totals, regression counters and quick wins.
- **Product / UX** — deterministic and optional reasoner UX opportunities, expected effects and confidence.
- **Engineering** — each finding's screenshot/video evidence, reproduction, expected/actual behavior, remediation hypothesis, regression risk and required regression-test guidance.

Severity and baseline-status filters are available without a server or external JavaScript dependency.

## Screenshot annotations

Visual findings use viewport-sized screenshots so DOM geometry can be overlaid accurately. When a visual event contains `rect`, `viewportWidth` and `viewportHeight`, the HTML report draws a red finding marker over the captured viewport.

## Remediation mapping safety

Beta.7 deliberately separates evidence from source-code attribution.

When the QA event supplies explicit `sourceFile` / `sourceSymbol` metadata, the report may display that mapping. Otherwise it renders:

```text
SOURCE_NOT_CONFIRMED
```

The report still provides a bounded root-cause hypothesis, recommended change, regression risk and regression-test shape. It does **not** invent a source path from a screenshot or selector.

## Regression context

The executive report surfaces both visual-baseline and GitHub regression-memory counters:

- new
- persistent
- resolved

A finding-level visual status is shown when the visual baseline annotated the event. Existing explicit baseline-update rules remain unchanged; generating a report never accepts a baseline.

## Evidence and privacy boundaries

- Report assets remain inside the run directory.
- Evidence paths stored in `report-data.json` are relative paths, not machine-specific absolute paths.
- HTML content is escaped before rendering.
- Video is off by default.
- Existing result/event/HAR privacy rules still apply; the report is a presentation layer over those artifacts and should be handled with the same access controls.
- Source mapping is unconfirmed unless explicit source metadata is present.

## Release gate

Beta.7 includes unit and real-Chromium gates for:

- HTML/JSON/Markdown generation;
- relative screenshot/video paths;
- HTML escaping;
- viewport video finalization;
- end-to-end `QaManager` report generation with a real deterministic visual finding.
