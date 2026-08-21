import type { ModelExecutionStatus } from '../contracts/quality-contracts.js';

export type UxOpportunityCategory =
  | 'discoverability'
  | 'cognitive-load'
  | 'consistency'
  | 'information-architecture'
  | 'first-time-experience'
  | 'accessibility'
  | 'efficiency'
  | 'feedback';

export type UxImpact = 'high' | 'medium' | 'low';

export interface UxPageSnapshot {
  urlPath: string;
  routeDepth: number;
  interactiveCount: number;
  buttonCount: number;
  linkCount: number;
  formFieldCount: number;
  unlabeledInteractiveCount: number;
  headings: number;
  h1Count: number;
  primaryActionKinds: string[];
  ambiguousActionCount: number;
  textChars: number;
  scrollRatio: number;
  navLandmarks: number;
  hasMeaningfulTitle: boolean;
}

export interface UxFlowSnapshot {
  actions: number;
  repeatedActions: number;
  backtracks: number;
  errors: number;
}

export interface UxOpportunity {
  id: string;
  category: UxOpportunityCategory;
  impact: UxImpact;
  confidence: number;
  title: string;
  observation: string;
  recommendation: string;
  expectedEffect: string;
  metric: string;
  source: 'deterministic' | 'reasoner';
}

export interface UxIntelligenceSummary {
  enabled: boolean;
  pagesAttempted: number;
  pagesAnalyzed: number;
  pagesFailed: number;
  completeness: number;
  valid: boolean;
  score: number;
  opportunities: number;
  highImpact: number;
  mediumImpact: number;
  lowImpact: number;
  reasonerStatus: ModelExecutionStatus;
  /** @deprecated Read reasonerStatus.used. Kept for Beta.9 result compatibility. */
  reasonerUsed: boolean;
  toolingError?: string;
}

export interface UxAgentResult {
  summary: UxIntelligenceSummary;
  opportunities: UxOpportunity[];
  snapshots: UxPageSnapshot[];
  flow: UxFlowSnapshot;
}

export interface UxReasonerContext {
  pages: UxPageSnapshot[];
  flow: UxFlowSnapshot;
  deterministic: UxOpportunity[];
}

export interface UxReasonerExecutionMetadata {
  provider?: string;
  repairAttempted: boolean;
}

export interface UxReasoner {
  propose(context: UxReasonerContext): Promise<Array<Omit<UxOpportunity, 'id' | 'source'>>>;
  getLastExecutionMetadata?(): UxReasonerExecutionMetadata | undefined;
}
