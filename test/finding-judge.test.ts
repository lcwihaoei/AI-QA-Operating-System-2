import { describe, expect, it } from 'vitest';
import { judgeFinding } from '../src/findings/finding-judge.js';

describe('Finding Judge', () => {
  it('classifies an intentional collapsed-state signal as QA-engine false positive when reproduction is absent', () => {
    expect(judgeFinding({
      detector: 'interactive-offscreen',
      visibility: 'intentionally-hidden',
      annotation: 'unverified',
      reproduction: 'not-run',
    }).verdict).toBe('qa-engine-false-positive');
  });

  it('requires independent reproduction before a product defect is confirmed', () => {
    const pending = judgeFinding({
      detector: 'interactive-overlap',
      visibility: 'visible',
      annotation: 'confirmed',
      reproduction: 'not-run',
    });
    expect(pending.verdict).toBe('potential-product-defect');
    expect(pending.confidenceCeiling).toBeLessThanOrEqual(0.8);

    const confirmed = judgeFinding({
      detector: 'interactive-overlap',
      visibility: 'visible',
      annotation: 'confirmed',
      reproduction: 'confirmed',
    });
    expect(confirmed.verdict).toBe('confirmed-product-defect');
  });

  it('does not confirm a product defect from a rejected annotation', () => {
    const result = judgeFinding({
      detector: 'interactive-overlap',
      visibility: 'visible',
      annotation: 'rejected',
      reproduction: 'confirmed',
    });
    expect(result.verdict).toBe('potential-product-defect');
  });

  it('gives explicit ownership to test and environment defects', () => {
    expect(judgeFinding({
      detector: 'assertion',
      visibility: 'unknown',
      annotation: 'not-applicable',
      reproduction: 'blocked',
      testDefect: true,
    }).verdict).toBe('test-defect');

    expect(judgeFinding({
      detector: 'network',
      visibility: 'unknown',
      annotation: 'not-applicable',
      reproduction: 'blocked',
      environment: true,
    }).verdict).toBe('environment');
  });
});
