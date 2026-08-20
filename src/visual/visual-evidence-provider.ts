import type { VisualSignal } from './dom-geometry-analyzer.js';

export type VisualEvidenceVerdict = 'confirm' | 'reject' | 'uncertain';

export interface VisualEvidenceAssessment {
  signalIndex: number;
  verdict: VisualEvidenceVerdict;
  confidence: number;
  reason?: string;
}

export interface VisualEvidenceInput {
  url: string;
  viewport: {
    name: string;
    width: number;
    height: number;
  };
  screenshotPath: string;
  signals: VisualSignal[];
}

export interface VisualEvidenceProvider {
  assess(input: VisualEvidenceInput): Promise<VisualEvidenceAssessment[]>;
}
