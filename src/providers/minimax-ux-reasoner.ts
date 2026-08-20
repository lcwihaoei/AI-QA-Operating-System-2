import { z } from 'zod';
import type { UxOpportunityCategory, UxReasoner, UxReasonerContext } from '../ux/ux-types.js';
import { MiniMaxChatClient } from './minimax-chat-client.js';

const categories: [UxOpportunityCategory, ...UxOpportunityCategory[]] = [
  'discoverability', 'cognitive-load', 'consistency', 'information-architecture', 'first-time-experience', 'accessibility', 'efficiency', 'feedback',
];
const responseSchema = z.object({
  opportunities: z.array(z.object({
    category: z.enum(categories),
    impact: z.enum(['high', 'medium', 'low']),
    confidence: z.number().min(0).max(1),
    title: z.string().min(1).max(180),
    observation: z.string().min(1).max(800),
    recommendation: z.string().min(1).max(1_000),
    expectedEffect: z.string().min(1).max(800),
    metric: z.string().min(1).max(200),
  })).max(16),
});

export class MiniMaxUxReasoner implements UxReasoner {
  private readonly client: MiniMaxChatClient;

  constructor(apiKey: string, model = 'minimax-m3', baseUrl = 'https://api.minimaxi.com/v1') {
    this.client = new MiniMaxChatClient(apiKey, model, baseUrl);
  }

  async propose(context: UxReasonerContext) {
    const compact = {
      pages: context.pages.slice(0, 30).map((page) => ({
        urlPath: page.urlPath,
        routeDepth: page.routeDepth,
        interactiveCount: page.interactiveCount,
        buttonCount: page.buttonCount,
        linkCount: page.linkCount,
        formFieldCount: page.formFieldCount,
        unlabeledInteractiveCount: page.unlabeledInteractiveCount,
        headings: page.headings,
        h1Count: page.h1Count,
        primaryActionKinds: page.primaryActionKinds.slice(0, 6),
        ambiguousActionCount: page.ambiguousActionCount,
        textChars: page.textChars,
        scrollRatio: page.scrollRatio,
        navLandmarks: page.navLandmarks,
        hasMeaningfulTitle: page.hasMeaningfulTitle,
      })),
      flow: context.flow,
      deterministic: context.deterministic.slice(0, 16).map(({ category, impact, confidence, title, metric }) => ({
        category, impact, confidence, title, metric,
      })),
    };
    const result = await this.client.completeJson(
      'You are a senior UX/product reviewer. Use only the aggregate metrics supplied. Do not invent user data or claim a defect without evidence. Return JSON only. Add opportunities; do not override deterministic findings.',
      `Suggest additional high-confidence UX opportunities. Schema: {"opportunities":[{"category":"discoverability|cognitive-load|consistency|information-architecture|first-time-experience|accessibility|efficiency|feedback","impact":"high|medium|low","confidence":0..1,"title":"...","observation":"...","recommendation":"...","expectedEffect":"...","metric":"..."}]}. Aggregate context: ${JSON.stringify(compact)}`,
      responseSchema,
    );
    return result.opportunities;
  }
}
