import type { ModelExecutionStatus } from '../contracts/quality-contracts.js';
import type { CandidateKind, CandidateRisk, CoverageSnapshot, PlannedCandidate, RiskMode } from '../core/types.js';
import type { PageStateSnapshot } from './page-state-analyzer.js';
import type { ScenarioIntent } from './scenario-generator.js';

export interface PlannerModelCandidate {
  id: string;
  kind: CandidateKind;
  label: string;
  href?: string;
  risk: CandidateRisk;
  allowed: boolean;
  baseScore: number;
  reasons: string[];
}

export interface PlannerModelContext {
  pageUrl: string;
  depth: number;
  riskMode: RiskMode;
  coverage: CoverageSnapshot;
  pageState: PageStateSnapshot;
  scenarios: ScenarioIntent[];
  candidates: PlannerModelCandidate[];
}

export interface PlannerModelRecommendation {
  candidateId: string;
  scoreDelta: number;
  reason?: string;
}

export interface PlannerModel {
  recommend(context: PlannerModelContext): Promise<PlannerModelRecommendation[]>;
}

export interface PlannerRankingResult {
  plans: PlannedCandidate[];
  scenarios: ScenarioIntent[];
  modelStatus: ModelExecutionStatus;
  /** @deprecated Read modelStatus.used. Kept for Beta.9 result compatibility. */
  modelUsed: boolean;
  /** @deprecated Read modelStatus.error. Kept for Beta.9 result compatibility. */
  modelError?: string;
}
