# M10 UX Experiment / Self-Learning

M10 converts M9 opportunities into measurable hypotheses and compares observed control/variant outcomes.

## Metrics

Each variant supplies bounded aggregate measurements:

- UX score from M9
- task completion rate
- median actions
- backtracks per task
- error rate
- sample size

The experiment engine calculates a bounded effect score and a sample-size confidence factor. This is an operational decision heuristic, **not a replacement for formal statistical inference**. Samples below the confidence threshold remain `inconclusive`.

Two guardrails override a superficially attractive variant:

- completion rate cannot drop by more than 3 percentage points
- error rate cannot increase by more than 2 percentage points

A guardrail violation is a regression even if the screen becomes shorter or the advisory UX score rises.

## Self-learning memory

`.qa-memory/ux-learning.json` stores accepted product baselines and explicitly recorded experiment winners. Reading/comparison is safe by default. The system never silently trains itself on a new design: baseline updates and experiment recording require explicit caller/CLI actions.

```bash
npm run ux:experiment -- --input experiment.json
npm run ux:experiment -- --input experiment.json --product product/a --accept-learning
```

This creates a closed loop:

```text
M9 opportunity → measurable hypothesis → control/variant run → guardrails → decision → explicit learning memory → future comparison
```
