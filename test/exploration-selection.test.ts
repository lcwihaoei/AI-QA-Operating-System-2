import { describe, expect, it } from 'vitest';
import type { PlannedCandidate } from '../src/core/types.js';
import { selectExplorationPlans } from '../src/planning/exploration-selection.js';

function plan(kind: 'link' | 'button' | 'field', index: number, score: number, href?: string): PlannedCandidate {
  return {
    candidate: {
      id: `${kind}-${index}`,
      kind,
      label: `${kind} ${index}`,
      href: kind === 'link' ? (href ?? `http://example.test/route-${index}`) : undefined,
      locatorIndex: index,
      tagName: kind === 'link' ? 'a' : kind === 'button' ? 'button' : 'input',
    },
    decision: { risk: 'low', allowed: true, interestScore: score, reasons: ['test'] },
    score,
  };
}

describe('selectExplorationPlans', () => {
  it('reserves interaction capacity when high-ranked links dominate', () => {
    const plans = [
      ...Array.from({ length: 20 }, (_, index) => plan('link', index, 200 - index)),
      plan('button', 30, 20),
      plan('field', 31, 19),
    ];
    const selected = selectExplorationPlans(plans, 12);
    expect(selected.navigation.length).toBeGreaterThanOrEqual(8);
    expect(selected.interactions.length).toBeGreaterThanOrEqual(1);
    expect(selected.interactions.some((item) => item.candidate.kind === 'button')).toBe(true);
  });

  it('reserves navigation breadth when interactions dominate ranking', () => {
    const plans = [
      ...Array.from({ length: 20 }, (_, index) => plan('button', index, 200 - index)),
      plan('link', 30, 10),
      plan('link', 31, 9),
    ];
    const selected = selectExplorationPlans(plans, 6);
    expect(selected.navigation.map((item) => item.candidate.id)).toEqual(['link-30', 'link-31']);
    expect(selected.interactions.length).toBeGreaterThanOrEqual(1);
  });

  it('diversifies top-level route families before filling one family deeply', () => {
    const plans = [
      plan('link', 1, 100, 'http://example.test/settings/profile'),
      plan('link', 2, 99, 'http://example.test/settings/security'),
      plan('link', 3, 98, 'http://example.test/settings/privacy'),
      plan('link', 4, 40, 'http://example.test/learning'),
      plan('link', 5, 39, 'http://example.test/vocabulary'),
      plan('link', 6, 38, 'http://example.test/practice'),
    ];
    const selected = selectExplorationPlans(plans, 4);
    expect(selected.navigation.map((item) => item.candidate.href)).toEqual([
      'http://example.test/settings/profile',
      'http://example.test/learning',
      'http://example.test/vocabulary',
      'http://example.test/practice',
    ]);
  });

  it('never selects blocked candidates', () => {
    const blocked = plan('button', 1, 999);
    blocked.decision = { ...blocked.decision, risk: 'blocked', allowed: false };
    const selected = selectExplorationPlans([blocked, plan('link', 2, 1)], 5);
    expect([...selected.navigation, ...selected.interactions].map((item) => item.candidate.id)).not.toContain('button-1');
  });
});
