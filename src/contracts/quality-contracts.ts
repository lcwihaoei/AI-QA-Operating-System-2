export type PercentagePoint = number & { readonly __percentagePoint: unique symbol };

export function percentagePoint(value: number): PercentagePoint {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`percentage point must be a finite number between 0 and 100, got ${String(value)}`);
  }
  return value as PercentagePoint;
}

export function formatPercentagePoint(value: number): string {
  const normalized = percentagePoint(value);
  const rounded = Math.round(normalized * 100) / 100;
  return `${rounded}%`;
}

export type VisibilityState =
  | 'visible'
  | 'intentionally-hidden'
  | 'not-rendered'
  | 'unknown';

export interface PageStateObservation {
  stateId: string;
  url: string;
  observedAt: string;
  visibility: VisibilityState;
  controlledBy?: string;
  expanded?: boolean;
  inert?: boolean;
  ariaHidden?: boolean;
  reasons: string[];
}

export type ModelExecutionOutcome =
  | 'not-configured'
  | 'skipped'
  | 'used'
  | 'repaired-and-used'
  | 'fallback'
  | 'failed';

export interface ModelExecutionStatus {
  configured: boolean;
  attempted: boolean;
  used: boolean;
  repairAttempted: boolean;
  fallbackUsed: boolean;
  outcome: ModelExecutionOutcome;
  provider?: string;
  error?: string;
  skipReason?: string;
}

export function assertModelExecutionStatus(status: ModelExecutionStatus): void {
  if (status.used && !status.attempted) throw new Error('model cannot be used without an attempt');
  if (status.attempted && !status.configured) throw new Error('model cannot be attempted when it is not configured');
  if (status.repairAttempted && !status.attempted) throw new Error('model repair requires an initial attempt');
  if (status.fallbackUsed && !status.attempted) throw new Error('model fallback must follow a model attempt');
  if ((status.outcome === 'fallback' || status.outcome === 'failed') && !status.error) {
    throw new Error(`${status.outcome} model status must preserve an error diagnostic`);
  }
  if (status.outcome === 'not-configured' && (status.configured || status.attempted || status.used || status.fallbackUsed || status.repairAttempted)) {
    throw new Error('not-configured outcome conflicts with execution flags');
  }
  if (status.outcome === 'skipped') {
    if (!status.configured || status.attempted || status.used || status.fallbackUsed || status.repairAttempted) {
      throw new Error('skipped outcome requires a configured but unattempted model');
    }
    if (!status.skipReason) throw new Error('skipped model status requires an explicit reason');
  }
  if (status.outcome === 'used' && (!status.used || status.repairAttempted || status.fallbackUsed)) {
    throw new Error('used outcome conflicts with execution flags');
  }
  if (status.outcome === 'repaired-and-used' && (!status.used || !status.repairAttempted || status.fallbackUsed)) {
    throw new Error('repaired-and-used outcome requires repaired successful model usage');
  }
}

export type EvidenceAvailability = 'available' | 'unavailable' | 'not-required';
export type AnnotationStatus = 'confirmed' | 'rejected' | 'not-applicable' | 'unverified';
export type ReproductionStatus = 'confirmed' | 'not-reproduced' | 'not-run' | 'blocked';
export type FindingVerdict =
  | 'confirmed-product-defect'
  | 'potential-product-defect'
  | 'qa-engine-false-positive'
  | 'test-defect'
  | 'environment'
  | 'ux-opportunity';

export interface EvidenceTruthAssessment {
  screenshot: EvidenceAvailability;
  screenshotReason?: string;
  annotation: AnnotationStatus;
  reproduction: ReproductionStatus;
  verdict: FindingVerdict;
  reasons: string[];
}

export function assertEvidenceTruthAssessment(assessment: EvidenceTruthAssessment): void {
  if (assessment.reasons.length === 0) throw new Error('evidence truth assessment requires at least one reason');
  if (assessment.screenshot === 'unavailable' && !assessment.screenshotReason) {
    throw new Error('unavailable screenshot evidence requires an explicit reason');
  }
  if (assessment.verdict === 'confirmed-product-defect') {
    if (assessment.reproduction !== 'confirmed') {
      throw new Error('confirmed product defect requires independent reproduction');
    }
    if (assessment.annotation === 'rejected') {
      throw new Error('confirmed product defect cannot rely on a rejected annotation');
    }
  }
  if (assessment.verdict === 'qa-engine-false-positive' && assessment.reproduction === 'confirmed') {
    throw new Error('qa-engine false positive cannot have a confirmed product reproduction');
  }
}
