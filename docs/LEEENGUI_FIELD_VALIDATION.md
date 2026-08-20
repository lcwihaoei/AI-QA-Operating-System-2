# LeeEngUI / Deep Frontend Field Validation

This profile is intended for large SPA frontends where the default fast crawl is too shallow to establish a trustworthy baseline.

## Recommended beta.3 run

From the AI QA Operating System directory, keep the target dev server running and use:

```bash
npm run qa -- \
  --url http://127.0.0.1:5173 \
  --max-actions 200 \
  --max-depth 6 \
  --max-candidates-per-page 24 \
  --risk-mode standard \
  --visual-viewports desktop,tablet,mobile \
  --control-plane-state .qa-control/state.json \
  --ux-product leeengui-stage17
```

Review `result.json`, `ux-opportunities.json`, screenshots and coverage before accepting any baseline.

Only after a healthy run should baseline/memory writes be enabled:

```bash
npm run qa -- \
  --url http://127.0.0.1:5173 \
  --max-actions 200 \
  --max-depth 6 \
  --max-candidates-per-page 24 \
  --risk-mode standard \
  --visual-viewports desktop,tablet,mobile \
  --control-plane-state .qa-control/state.json \
  --ux-product leeengui-stage17 \
  --update-visual-baseline \
  --update-ux-memory \
  --update-github-regression-memory
```

The runtime now refuses a visual baseline update when zero visual states were analyzed, and refuses UX learning updates unless UX analysis is valid and at least 80% complete.

## MiniMax CN

A local `.env` can be used; it is gitignored:

```env
MINIMAX_API_KEY=YOUR_KEY_HERE
MINIMAX_MODEL=minimax-m3
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
```

`minimax-m3` is accepted as a friendly alias and normalized to `MiniMax-M3`. An explicit AIQA planner or UX endpoint takes precedence over the direct MiniMax provider.

## What beta.3 specifically guards

- route-family breadth: one deep `/settings/*` family cannot consume the full navigation budget;
- interaction fairness: allowed buttons/fields cannot be permanently starved by links;
- real click execution: the release gate launches Chromium and verifies a safe button is actually clicked;
- UX health: zero analyzed pages is invalid and scores 0, not 100;
- baseline provenance: a clean zero-signal visual baseline is accepted only when visual analysis actually ran;
- shared-component deduplication: the same browser UI structural issue repeated on many routes is one finding rather than route-count spam.
