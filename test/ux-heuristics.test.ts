import { describe, expect, it } from 'vitest';
import { analyzeUx, buildUxFlowSnapshot, scoreUx } from '../src/ux/ux-heuristics.js';
import type { UxPageSnapshot } from '../src/ux/ux-types.js';

function page(overrides: Partial<UxPageSnapshot> = {}): UxPageSnapshot {
  return {
    urlPath: '/settings', routeDepth: 1, interactiveCount: 8, buttonCount: 2, linkCount: 3, formFieldCount: 2,
    unlabeledInteractiveCount: 0, headings: 3, h1Count: 1, primaryActionKinds: ['save'], ambiguousActionCount: 0,
    textChars: 1200, scrollRatio: 1.4, navLandmarks: 1, hasMeaningfulTitle: true, ...overrides,
  };
}

describe('UX intelligence heuristics', () => {
  it('finds improvement opportunities even when there is no functional bug', () => {
    const opportunities = analyzeUx([
      page({ interactiveCount: 60, unlabeledInteractiveCount: 5, routeDepth: 6, h1Count: 0, primaryActionKinds: [] }),
    ], { actions: 8, repeatedActions: 0, backtracks: 0, errors: 0 });
    expect(opportunities.map((item) => item.category)).toEqual(expect.arrayContaining(['accessibility', 'cognitive-load', 'information-architecture', 'first-time-experience', 'discoverability']));
    expect(scoreUx(opportunities)).toBeLessThan(100);
  });

  it('detects inconsistent completion vocabulary across otherwise valid pages', () => {
    const opportunities = analyzeUx([
      page({ primaryActionKinds: ['save'] }), page({ urlPath: '/profile', primaryActionKinds: ['apply'] }), page({ urlPath: '/account', primaryActionKinds: ['update'] }),
    ], { actions: 3, repeatedActions: 0, backtracks: 0, errors: 0 });
    expect(opportunities.some((item) => item.category === 'consistency')).toBe(true);
  });

  it('derives repeated action/backtracking friction without persisting action content', () => {
    const flow = buildUxFlowSnapshot([
      { timestamp: '1', kind: 'action', url: 'https://x.test', message: 'Open Settings' },
      { timestamp: '2', kind: 'action', url: 'https://x.test', message: 'Go Back' },
      { timestamp: '3', kind: 'action', url: 'https://x.test', message: 'Open Settings' },
    ]);
    expect(flow).toMatchObject({ actions: 3, repeatedActions: 1, backtracks: 1 });
    expect(JSON.stringify(flow)).not.toContain('Settings');
  });

  it('returns a clean score for a small well-structured flow', () => {
    const opportunities = analyzeUx([page()], { actions: 2, repeatedActions: 0, backtracks: 0, errors: 0 });
    expect(opportunities).toHaveLength(0);
    expect(scoreUx(opportunities)).toBe(100);
  });
});
