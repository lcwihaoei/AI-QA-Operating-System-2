import { describe, expect, it } from 'vitest';
import { uxBaselineEligible } from '../src/agents/ux-agent.js';
import type { UxIntelligenceSummary } from '../src/ux/ux-types.js';

function summary(overrides: Partial<UxIntelligenceSummary> = {}): UxIntelligenceSummary {
  return {
    enabled: true,
    pagesAttempted: 10,
    pagesAnalyzed: 10,
    pagesFailed: 0,
    completeness: 1,
    valid: true,
    score: 82,
    opportunities: 2,
    highImpact: 0,
    mediumImpact: 2,
    lowImpact: 0,
    reasonerStatus: {
      configured: false,
      attempted: false,
      used: false,
      repairAttempted: false,
      fallbackUsed: false,
      outcome: 'not-configured',
    },
    reasonerUsed: false,
    ...overrides,
  };
}

describe('UX analysis health', () => {
  it('refuses a zero-snapshot baseline instead of treating it as a perfect 100', () => {
    const invalid = summary({ pagesAttempted: 7, pagesAnalyzed: 0, pagesFailed: 7, completeness: 0, valid: false, score: 0, opportunities: 0 });
    expect(invalid.score).toBe(0);
    expect(uxBaselineEligible(invalid)).toBe(false);
  });

  it('refuses materially incomplete analysis', () => {
    expect(uxBaselineEligible(summary({ pagesAnalyzed: 6, pagesFailed: 4, completeness: 0.6 }))).toBe(false);
  });

  it('accepts a sufficiently complete valid analysis', () => {
    expect(uxBaselineEligible(summary({ pagesAnalyzed: 8, pagesFailed: 2, completeness: 0.8 }))).toBe(true);
  });
});
