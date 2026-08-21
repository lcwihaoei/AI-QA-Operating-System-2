import { describe, expect, it } from 'vitest';
import type { QaEvent } from '../src/core/types.js';
import { applyFindingTruth } from '../src/findings/finding-truth-pipeline.js';
import { findingsFromEvents } from '../src/reporting/bug-reporter.js';

function event(overrides: Partial<QaEvent['details']> = {}): QaEvent {
  return {
    timestamp: '2026-08-21T00:00:00.000Z',
    kind: 'ui',
    url: 'https://example.com/settings',
    message: 'Visible text appears clipped: span.label [viewport=tablet 768x1024]',
    details: {
      visual: true,
      visualKind: 'text-clipping',
      viewport: 'tablet',
      viewportWidth: 768,
      viewportHeight: 1024,
      element: 'span.label',
      rect: { x: 24, y: 40, width: 180, height: 24 },
      screenshot: '/tmp/run/screenshots/finding.png',
      reproductionStatus: 'confirmed',
      reproductionReason: 'fresh context emitted the same signal',
      ...overrides,
    },
  };
}

describe('Beta.10 finding truth pipeline', () => {
  it('promotes a visible independently reproduced visual signal to confirmed product defect', () => {
    const [judged] = applyFindingTruth([event()]);
    const truth = judged?.details?.truthAssessment as { verdict?: string; reproduction?: string } | undefined;
    expect(truth).toMatchObject({ verdict: 'confirmed-product-defect', reproduction: 'confirmed' });
    expect(judged?.details?.visibilityState).toBe('visible');

    const [finding] = findingsFromEvents([judged!]);
    expect(finding?.truth?.verdict).toBe('confirmed-product-defect');
  });

  it('does not call a fully offscreen geometry signal confirmed when semantic visibility is unknown', () => {
    const [judged] = applyFindingTruth([event({
      visualKind: 'interactive-offscreen',
      element: 'button#bad',
      rect: { x: -220, y: 120, width: 100, height: 40 },
      reproductionStatus: 'confirmed',
    })]);
    const truth = judged?.details?.truthAssessment as { verdict?: string; annotation?: string } | undefined;
    expect(judged?.details?.visibilityState).toBe('unknown');
    expect(truth).toMatchObject({ verdict: 'potential-product-defect', annotation: 'unverified' });
  });

  it('classifies a bounded non-reproduction as QA-engine false positive', () => {
    const [judged] = applyFindingTruth([event({
      reproductionStatus: 'not-reproduced',
      reproductionReason: 'fresh context did not emit the signal',
    })]);
    const truth = judged?.details?.truthAssessment as { verdict?: string } | undefined;
    expect(truth?.verdict).toBe('qa-engine-false-positive');
  });

  it('downgrades otherwise confirmed visual evidence when screenshot evidence is missing', () => {
    const [judged] = applyFindingTruth([event({ screenshot: undefined })]);
    const truth = judged?.details?.truthAssessment as { verdict?: string; screenshot?: string; screenshotReason?: string } | undefined;
    expect(truth?.verdict).toBe('potential-product-defect');
    expect(truth?.screenshot).toBe('unavailable');
    expect(truth?.screenshotReason).toMatch(/no screenshot evidence/i);
  });
});
