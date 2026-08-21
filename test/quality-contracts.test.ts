import { describe, expect, it } from 'vitest';
import {
  assertEvidenceTruthAssessment,
  assertModelExecutionStatus,
  formatPercentagePoint,
  percentagePoint,
} from '../src/contracts/quality-contracts.js';

describe('Beta.10 canonical quality contracts', () => {
  it('treats coverage values as percentage points rather than fractions', () => {
    expect(formatPercentagePoint(100)).toBe('100%');
    expect(formatPercentagePoint(16)).toBe('16%');
    expect(formatPercentagePoint(0)).toBe('0%');
    expect(() => percentagePoint(100.01)).toThrow(/between 0 and 100/);
    expect(() => percentagePoint(Number.NaN)).toThrow(/finite number/);
  });

  it('requires model fallback diagnostics to remain machine-readable', () => {
    expect(() => assertModelExecutionStatus({
      configured: true,
      attempted: true,
      used: false,
      repairAttempted: true,
      fallbackUsed: true,
      outcome: 'fallback',
      provider: 'minimax-cn:minimax-m3',
      error: 'recommendations: expected array, received undefined',
    })).not.toThrow();

    expect(() => assertModelExecutionStatus({
      configured: true,
      attempted: true,
      used: false,
      repairAttempted: false,
      fallbackUsed: true,
      outcome: 'fallback',
    })).toThrow(/preserve an error diagnostic/);
  });

  it('requires a configured model skip to preserve why no attempt happened', () => {
    expect(() => assertModelExecutionStatus({
      configured: true,
      attempted: false,
      used: false,
      repairAttempted: false,
      fallbackUsed: false,
      outcome: 'skipped',
      skipReason: 'no eligible planner candidates',
    })).not.toThrow();

    expect(() => assertModelExecutionStatus({
      configured: true,
      attempted: false,
      used: false,
      repairAttempted: false,
      fallbackUsed: false,
      outcome: 'skipped',
    })).toThrow(/explicit reason/);
  });

  it('does not allow a detector signal to become a confirmed product defect without reproduction', () => {
    expect(() => assertEvidenceTruthAssessment({
      screenshot: 'available',
      annotation: 'unverified',
      reproduction: 'not-run',
      verdict: 'potential-product-defect',
      reasons: ['deterministic geometry signal requires independent confirmation'],
    })).not.toThrow();

    expect(() => assertEvidenceTruthAssessment({
      screenshot: 'available',
      annotation: 'confirmed',
      reproduction: 'not-run',
      verdict: 'confirmed-product-defect',
      reasons: ['geometry detector emitted overlap'],
    })).toThrow(/requires independent reproduction/);
  });

  it('requires an explicit reason when screenshot evidence is unavailable', () => {
    expect(() => assertEvidenceTruthAssessment({
      screenshot: 'unavailable',
      annotation: 'not-applicable',
      reproduction: 'blocked',
      verdict: 'environment',
      reasons: ['browser capture failed'],
    })).toThrow(/explicit reason/);

    expect(() => assertEvidenceTruthAssessment({
      screenshot: 'unavailable',
      screenshotReason: 'browser context closed before capture',
      annotation: 'not-applicable',
      reproduction: 'blocked',
      verdict: 'environment',
      reasons: ['browser capture failed'],
    })).not.toThrow();
  });
});
