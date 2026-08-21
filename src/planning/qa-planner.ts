import { assertModelExecutionStatus, type ModelExecutionStatus } from '../contracts/quality-contracts.js';
import type { ExplorationCandidate, PlannedCandidate, RiskMode } from '../core/types.js';
import { CoverageGraph } from './coverage-graph.js';
import { HumanLikePolicy } from './human-like-policy.js';
import type { PlannerModel, PlannerModelContext, PlannerRankingResult } from './planner-model.js';
import type { PageStateSnapshot } from './page-state-analyzer.js';
import { ScenarioGenerator } from './scenario-generator.js';

export class QaPlanner {
  constructor(
    private readonly coverage: CoverageGraph,
    private readonly policy: HumanLikePolicy = new HumanLikePolicy(),
    private readonly model?: PlannerModel,
    private readonly scenarioGenerator: ScenarioGenerator = new ScenarioGenerator(),
  ) {}

  async rank(
    pageUrl: string,
    depth: number,
    candidates: ExplorationCandidate[],
    riskMode: RiskMode,
    pageState?: PageStateSnapshot,
  ): Promise<PlannerRankingResult> {
    const effectiveState: PageStateSnapshot = pageState ?? {
      url: pageUrl,
      title: '',
      headings: [],
      bodySample: '',
      formCount: 0,
      fieldCount: 0,
      searchFieldCount: 0,
      buttonCount: 0,
      linkCount: 0,
      hasDialog: false,
      hasTable: false,
      archetypes: ['generic'],
    };
    const scenarios = this.scenarioGenerator.generate(effectiveState);

    const plans = candidates.map((candidate) => {
      const policyDecision = this.policy.evaluate(candidate, riskMode);
      const scenarioScore = this.scenarioGenerator.scoreCandidate(candidate, scenarios);
      const decision = {
        ...policyDecision,
        reasons: [...policyDecision.reasons, ...scenarioScore.reasons],
      };
      this.coverage.discoverCandidate(pageUrl, candidate, decision.risk, decision.allowed);

      let score = decision.interestScore + scenarioScore.boost;
      if (!this.coverage.wasCandidateExercised(pageUrl, candidate.id)) score += 30;
      if (candidate.kind === 'link' && candidate.href && !this.coverage.hasVisited(candidate.href)) score += 28;
      score -= Math.min(18, depth * 3);
      if (decision.risk === 'medium') score -= 20;
      if (!decision.allowed) score = -1000;

      return { candidate, decision, score } satisfies PlannedCandidate;
    });

    let modelStatus: ModelExecutionStatus;
    if (!this.model) {
      modelStatus = {
        configured: false,
        attempted: false,
        used: false,
        repairAttempted: false,
        fallbackUsed: false,
        outcome: 'not-configured',
      };
    } else if (plans.length === 0) {
      modelStatus = {
        configured: true,
        attempted: false,
        used: false,
        repairAttempted: false,
        fallbackUsed: false,
        outcome: 'skipped',
        skipReason: 'no planner candidates were available for model ranking',
      };
    } else {
      const context: PlannerModelContext = {
        pageUrl,
        depth,
        riskMode,
        coverage: this.coverage.snapshot(),
        pageState: effectiveState,
        scenarios,
        candidates: plans.map((plan) => ({
          id: plan.candidate.id,
          kind: plan.candidate.kind,
          label: plan.candidate.label,
          href: plan.candidate.href,
          risk: plan.decision.risk,
          allowed: plan.decision.allowed,
          baseScore: plan.score,
          reasons: plan.decision.reasons,
        })),
      };

      try {
        const recommendations = await this.model.recommend(context);
        const metadata = this.model.getLastExecutionMetadata?.();
        const byId = new Map(recommendations.map((recommendation) => [recommendation.candidateId, recommendation]));
        for (const plan of plans) {
          if (!plan.decision.allowed) continue;
          const recommendation = byId.get(plan.candidate.id);
          if (!recommendation) continue;
          const delta = Math.max(-40, Math.min(40, recommendation.scoreDelta));
          plan.score += delta;
          if (recommendation.reason) {
            plan.decision = {
              ...plan.decision,
              reasons: [...plan.decision.reasons, `model: ${recommendation.reason}`],
            };
          }
        }
        const repaired = metadata?.repairAttempted === true;
        modelStatus = {
          configured: true,
          attempted: true,
          used: true,
          repairAttempted: repaired,
          fallbackUsed: false,
          outcome: repaired ? 'repaired-and-used' : 'used',
          provider: metadata?.provider,
        };
      } catch (error: unknown) {
        const metadata = this.model.getLastExecutionMetadata?.();
        modelStatus = {
          configured: true,
          attempted: true,
          used: false,
          repairAttempted: metadata?.repairAttempted === true,
          fallbackUsed: true,
          outcome: 'fallback',
          provider: metadata?.provider,
          error: String(error),
        };
      }
    }

    assertModelExecutionStatus(modelStatus);

    plans.sort((a, b) => {
      if (a.decision.allowed !== b.decision.allowed) return a.decision.allowed ? -1 : 1;
      return b.score - a.score || a.candidate.locatorIndex - b.candidate.locatorIndex;
    });

    return {
      plans,
      scenarios,
      modelStatus,
      modelUsed: modelStatus.used,
      modelError: modelStatus.error,
    };
  }
}
