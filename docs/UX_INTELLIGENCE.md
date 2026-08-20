# M9 Autonomous UX / Product Intelligence

M9 is deliberately separate from defect QA. A screen can be functionally correct and still produce `UX Opportunity` records.

## What it evaluates

- discoverability of completion actions
- cognitive load / simultaneous choice density
- terminology consistency
- route depth and long-page information architecture
- first-time-user hierarchy signals
- unlabeled interactive controls
- repeated actions/backtracking efficiency friction

The deterministic layer uses aggregate page metrics and bounded flow counters. It does not persist DOM text, input values, cookies, user identifiers or form contents.

## Optional reasoning layer

`HttpUxReasoner` can propose additional product/UX opportunities, but receives only aggregate metrics, flow counts and the titles/categories of deterministic opportunities. It cannot suppress deterministic findings and low-confidence (<0.6) suggestions are discarded.

UX output is advisory and is **not** converted into a product Bug finding. This prevents subjective design recommendations from failing the QA quality gate.

## Scoring

The UX score starts at 100 and applies confidence-weighted penalties for high/medium/low impact opportunities. M10 uses this score together with task metrics to compare experiments over time; it is not treated as a universal benchmark across unrelated products.
