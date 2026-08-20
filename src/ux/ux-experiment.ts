export interface UxVariantMeasurement {
  id: string;
  sampleSize: number;
  uxScore: number;
  completionRate: number;
  medianActions: number;
  backtracksPerTask: number;
  errorRate: number;
}

export type UxExperimentDecision = 'improved' | 'regressed' | 'stable' | 'inconclusive';

export interface UxVariantResult {
  id: string;
  decision: UxExperimentDecision;
  effectScore: number;
  confidence: number;
  guardrailViolation: boolean;
  deltas: {
    uxScore: number;
    completionRate: number;
    medianActions: number;
    backtracksPerTask: number;
    errorRate: number;
  };
}

export interface UxExperimentResult {
  controlId: string;
  generatedAt: string;
  variants: UxVariantResult[];
  winner?: string;
}

function clamp(value: number, min = -1, max = 1): number { return Math.max(min, Math.min(value, max)); }
function boundedMetric(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} is outside allowed range`);
  return value;
}

export function validateMeasurement(value: UxVariantMeasurement): UxVariantMeasurement {
  if (!value.id || value.id.length > 100) throw new Error('variant id is missing or oversized');
  boundedMetric(value.sampleSize, 1, 1_000_000, 'sampleSize');
  if (!Number.isInteger(value.sampleSize)) throw new Error('sampleSize must be an integer');
  boundedMetric(value.uxScore, 0, 100, 'uxScore');
  boundedMetric(value.completionRate, 0, 1, 'completionRate');
  boundedMetric(value.medianActions, 0, 10_000, 'medianActions');
  boundedMetric(value.backtracksPerTask, 0, 10_000, 'backtracksPerTask');
  boundedMetric(value.errorRate, 0, 1, 'errorRate');
  return value;
}

function compareOne(control: UxVariantMeasurement, variant: UxVariantMeasurement): UxVariantResult {
  validateMeasurement(control); validateMeasurement(variant);
  const deltas = {
    uxScore: variant.uxScore - control.uxScore,
    completionRate: variant.completionRate - control.completionRate,
    medianActions: variant.medianActions - control.medianActions,
    backtracksPerTask: variant.backtracksPerTask - control.backtracksPerTask,
    errorRate: variant.errorRate - control.errorRate,
  };
  const ux = clamp(deltas.uxScore / 20);
  const completion = clamp(deltas.completionRate / 0.2);
  const actions = control.medianActions === 0 ? 0 : clamp((control.medianActions - variant.medianActions) / Math.max(control.medianActions, 1));
  const backtracks = control.backtracksPerTask === 0 ? (variant.backtracksPerTask === 0 ? 0 : -1) : clamp((control.backtracksPerTask - variant.backtracksPerTask) / control.backtracksPerTask);
  const errors = clamp((control.errorRate - variant.errorRate) / Math.max(control.errorRate, 0.05));
  const effectScore = Math.round((ux * 0.25 + completion * 0.30 + actions * 0.20 + backtracks * 0.10 + errors * 0.15) * 1000) / 10;
  const confidence = Math.round(Math.min(1, Math.sqrt(Math.min(control.sampleSize, variant.sampleSize) / 25)) * 100) / 100;
  const guardrailViolation = deltas.completionRate < -0.03 || deltas.errorRate > 0.02;
  const decision: UxExperimentDecision = guardrailViolation
    ? 'regressed'
    : confidence < 0.6
      ? 'inconclusive'
      : effectScore >= 5
        ? 'improved'
        : effectScore <= -5
          ? 'regressed'
          : 'stable';
  return { id: variant.id, decision, effectScore, confidence, guardrailViolation, deltas };
}

export function evaluateUxExperiment(control: UxVariantMeasurement, variants: UxVariantMeasurement[]): UxExperimentResult {
  if (variants.length < 1 || variants.length > 50) throw new Error('experiment requires 1-50 variants');
  const results = variants.map((variant) => compareOne(control, variant));
  const winner = results.filter((item) => item.decision === 'improved')
    .sort((a, b) => b.effectScore - a.effectScore || b.confidence - a.confidence)[0]?.id;
  return { controlId: control.id, generatedAt: new Date().toISOString(), variants: results, winner };
}
