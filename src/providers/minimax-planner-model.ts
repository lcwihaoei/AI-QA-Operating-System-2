import { z } from 'zod';
import type {
  PlannerModel,
  PlannerModelContext,
  PlannerModelExecutionMetadata,
  PlannerModelRecommendation,
} from '../planning/planner-model.js';
import { MiniMaxChatClient } from './minimax-chat-client.js';

const responseSchema = z.object({
  recommendations: z.array(z.object({
    candidateId: z.string().min(1),
    scoreDelta: z.number().finite().min(-40).max(40),
    reason: z.string().max(500).optional(),
  })).max(120),
});

function redactText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:bearer|token|secret|password|api[_ -]?key)\s*[:=]?\s*[^\s,;]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[opaque]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function pathOnly(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.pathname.slice(0, 240);
  } catch {
    return redactText(value).split('?')[0];
  }
}

export class MiniMaxPlannerModel implements PlannerModel {
  private readonly client: MiniMaxChatClient;

  constructor(apiKey: string, model = 'minimax-m3', baseUrl = 'https://api.minimaxi.com/v1') {
    this.client = new MiniMaxChatClient(apiKey, model, baseUrl);
  }

  getLastExecutionMetadata(): PlannerModelExecutionMetadata | undefined {
    const stats = this.client.getLastCallStats();
    if (!stats) return undefined;
    return {
      provider: `minimax:${stats.model}`,
      repairAttempted: stats.schemaRepairAttempts > 0,
    };
  }

  async recommend(context: PlannerModelContext): Promise<PlannerModelRecommendation[]> {
    const compact = {
      pagePath: pathOnly(context.pageUrl),
      depth: context.depth,
      riskMode: context.riskMode,
      pageState: {
        archetypes: context.pageState.archetypes.slice(0, 6),
        formCount: context.pageState.formCount,
        fieldCount: context.pageState.fieldCount,
        searchFieldCount: context.pageState.searchFieldCount,
        buttonCount: context.pageState.buttonCount,
        linkCount: context.pageState.linkCount,
        hasDialog: context.pageState.hasDialog,
        hasTable: context.pageState.hasTable,
      },
      scenarios: context.scenarios.slice(0, 12).map((scenario) => ({
        id: scenario.id,
        label: redactText(scenario.label),
        priority: scenario.priority,
      })),
      coverage: {
        score: context.coverage.score,
        pageCoverage: context.coverage.pageCoverage,
        interactionCoverage: context.coverage.interactionCoverage,
        gaps: context.coverage.gaps.slice(0, 8).map(redactText),
      },
      candidates: context.candidates.slice(0, 60).map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        label: redactText(candidate.label),
        href: pathOnly(candidate.href),
        risk: candidate.risk,
        allowed: candidate.allowed,
        baseScore: candidate.baseScore,
        reasons: candidate.reasons.slice(0, 4).map(redactText),
      })),
    };
    const result = await this.client.completeJson(
      'You are a conservative QA exploration planner. Never recommend blocked candidates. Return JSON only. Prefer broad product coverage and meaningful low-risk interactions over repeatedly following one route family.',
      `Rank the candidate actions by returning score deltas only for candidates worth changing. Schema: {"recommendations":[{"candidateId":"...","scoreDelta":number between -40 and 40,"reason":"short reason"}]}. Context: ${JSON.stringify(compact)}`,
      responseSchema,
    );
    return result.recommendations;
  }
}
