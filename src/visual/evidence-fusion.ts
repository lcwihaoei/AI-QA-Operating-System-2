import type { VisualSignal, VisualSignalSeverity } from './dom-geometry-analyzer.js';
import type { VisualEvidenceAssessment } from './visual-evidence-provider.js';

export interface FusedVisualSignal {
  signal: VisualSignal;
  severity: VisualSignalSeverity;
  assessment?: {
    verdict: VisualEvidenceAssessment['verdict'];
    confidence: number;
    reason?: string;
  };
}

export function fuseVisualEvidence(
  signals: VisualSignal[],
  assessments: VisualEvidenceAssessment[],
): FusedVisualSignal[] {
  const byIndex = new Map<number, VisualEvidenceAssessment>();
  for (const assessment of assessments) {
    if (!Number.isInteger(assessment.signalIndex)) continue;
    if (assessment.signalIndex < 0 || assessment.signalIndex >= signals.length) continue;
    const confidence = Math.max(0, Math.min(1, assessment.confidence));
    const normalized = { ...assessment, confidence };
    const current = byIndex.get(assessment.signalIndex);
    if (!current || normalized.confidence > current.confidence) byIndex.set(assessment.signalIndex, normalized);
  }

  return signals.map((signal, index) => {
    const assessment = byIndex.get(index);
    let severity: VisualSignalSeverity = signal.severity;

    // External visual evidence can reduce confidence in a deterministic signal,
    // but it cannot suppress it entirely or promote it above the geometry layer's ceiling.
    if (assessment?.verdict === 'reject' && assessment.confidence >= 0.85) {
      severity = 'low';
    }

    return {
      signal,
      severity,
      assessment: assessment
        ? {
            verdict: assessment.verdict,
            confidence: assessment.confidence,
            reason: assessment.reason,
          }
        : undefined,
    };
  });
}
