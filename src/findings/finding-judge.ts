import type {
  AnnotationStatus,
  FindingVerdict,
  ReproductionStatus,
  VisibilityState,
} from '../contracts/quality-contracts.js';

export interface FindingJudgementInput {
  detector: string;
  visibility: VisibilityState;
  annotation: AnnotationStatus;
  reproduction: ReproductionStatus;
  testDefect?: boolean;
  environment?: boolean;
  uxOpportunity?: boolean;
}

export interface FindingJudgement {
  verdict: FindingVerdict;
  confidenceCeiling: number;
  reasons: string[];
}

export function judgeFinding(input: FindingJudgementInput): FindingJudgement {
  if (input.testDefect) {
    return { verdict: 'test-defect', confidenceCeiling: 1, reasons: ['test infrastructure or assertion owns the failure'] };
  }
  if (input.environment) {
    return { verdict: 'environment', confidenceCeiling: 1, reasons: ['environmental evidence owns the failure'] };
  }
  if (input.uxOpportunity) {
    return { verdict: 'ux-opportunity', confidenceCeiling: 1, reasons: ['signal is a non-defect product/UX opportunity'] };
  }

  if (input.visibility === 'intentionally-hidden' && input.reproduction !== 'confirmed') {
    return {
      verdict: 'qa-engine-false-positive',
      confidenceCeiling: input.annotation === 'rejected' ? 0.99 : 0.95,
      reasons: ['detector signal belongs to an explicitly intentional hidden/collapsed state', 'independent product reproduction is not confirmed'],
    };
  }

  if (input.reproduction === 'confirmed' && input.annotation !== 'rejected') {
    return {
      verdict: 'confirmed-product-defect',
      confidenceCeiling: input.annotation === 'confirmed' ? 0.99 : 0.9,
      reasons: ['independent reproduction confirmed the observed product behavior', `detector=${input.detector}`],
    };
  }

  if (input.reproduction === 'not-reproduced') {
    return {
      verdict: 'qa-engine-false-positive',
      confidenceCeiling: 0.9,
      reasons: ['bounded independent reproduction did not reproduce the detector signal as a product defect'],
    };
  }

  return {
    verdict: 'potential-product-defect',
    confidenceCeiling: input.annotation === 'confirmed' ? 0.8 : 0.65,
    reasons: ['detector signal remains unconfirmed by independent reproduction', `visibility=${input.visibility}`, `annotation=${input.annotation}`],
  };
}
