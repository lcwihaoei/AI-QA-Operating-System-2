# AI QA Operating System v0.10.0-beta.7

Evidence-reporting release that turns the reliability work from beta.6 into a portable QA deliverable for engineering, product, UX and release review.

## Evidence-rich report bundle

Every normal QA run now produces an offline report bundle under `.qa-runs/<run-id>/report/`:

- `index.html` — interactive review UI;
- `report-data.json` — structured report model;
- `executive-summary.md` — compact handoff summary.

The HTML report contains Executive, Product/UX and Engineering views and requires no external JavaScript or stylesheet dependency.

## Screenshot and video evidence

- Deterministic visual findings link directly to their captured screenshots.
- Visual screenshots are captured at viewport size so geometry rectangles can be rendered as issue annotations in the correct location.
- `--record-video` enables one Playwright recording per requested visual viewport and links recordings from affected findings.
- Video remains opt-in because it increases evidence size and can contain on-screen product data.
- `--no-evidence-report` disables the report layer without changing the underlying QA run.

## Engineering remediation mapping

Each finding can now expose:

- severity, classification, regression status and confidence;
- expected versus actual behavior;
- recorded reproduction steps;
- screenshot/video evidence;
- bounded root-cause hypothesis;
- recommended engineering change;
- regression risk;
- required regression-test guidance.

Source attribution has an explicit safety boundary. If a run does not contain confirmed `sourceFile`/`sourceSymbol` metadata, the report displays `SOURCE_NOT_CONFIRMED` rather than inventing a component or file path from a screenshot or selector.

## Product and UX review

- UX opportunities are presented independently from deterministic product defects.
- High-impact/high-confidence opportunities are surfaced as quick wins.
- Executive regression counters summarize visual-baseline and GitHub finding-memory new, persistent and resolved states.
- Finding filters allow reviewers to focus on severity and regression state without running a report server.

## Portability and privacy

- Report evidence references are relative to the run directory; machine-specific absolute evidence paths are not written to `report-data.json`.
- Candidate evidence outside the current run directory is not linked into the report.
- Dynamic report text is HTML-escaped before rendering.
- Report generation does not update visual, GitHub or UX baselines and does not create external issues.
- Existing baseline/memory opt-in safety boundaries remain unchanged.

## Baseline compatibility

Beta.7 does not change the beta.6 visual classifier or finding fingerprint algorithm. Existing beta.6 reliability boundaries remain in force:

- visual baseline schema 3 / `dom-geometry-v3`;
- GitHub regression memory classifier `qa-engine-beta6` with `finding-v2` fingerprints.

A beta.7 report can therefore be layered on a healthy beta.6-derived baseline without an automatic migration. Baseline acceptance remains explicit.

## Verified release gates

The prerelease workflow requires:

- tracked-file credential/private-key, merge-conflict and 5 MiB safety scans;
- `npm audit --audit-level=high`;
- TypeScript build and the full Vitest suite;
- Playwright Chromium installation;
- BrowserExplorer breadth/real-click E2E;
- VisualAgent provenance and real video-finalization E2E;
- DOM-geometry false-positive/true-positive regression gates;
- offline evidence-report HTML/JSON/Markdown generation and HTML-escaping/relative-path tests;
- end-to-end `QaManager` report generation from a real Chromium visual finding, including screenshot and video evidence;
- `npm pack --dry-run`;
- release tarball creation and SHA-256 checksum.

## Safety posture

- This remains a prerelease.
- Release creation targets the verified beta.7 integration-branch SHA; `main` remains the review/merge surface.
- Report presentation never changes the underlying finding classifier.
- Video capture is explicit opt-in.
- Source paths are never guessed when source metadata is absent.
- Baseline/learning writes remain explicit opt-ins and are never silently accepted.
