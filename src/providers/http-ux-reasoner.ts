import { z } from 'zod';
import { isSecureServiceEndpoint } from '../security/url-policy.js';
import type { UxOpportunityCategory, UxReasoner, UxReasonerContext } from '../ux/ux-types.js';

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
  })).max(20),
});

export class HttpUxReasoner implements UxReasoner {
  constructor(private readonly endpoint: string, private readonly token?: string, private readonly timeoutMs = 12_000) {
    if (!isSecureServiceEndpoint(endpoint)) throw new Error('UX reasoner endpoint must use HTTPS unless localhost/loopback');
  }

  async propose(context: UxReasonerContext) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const payload = {
      version: 1,
      task: 'identify-product-ux-opportunities-from-aggregate-metrics',
      context: {
        pages: context.pages.slice(0, 50),
        flow: context.flow,
        deterministic: context.deterministic.slice(0, 30).map(({ category, impact, confidence, title, metric }) => ({ category, impact, confidence, title, metric })),
      },
    };
    const response = await fetch(this.endpoint, {
      method: 'POST', headers, redirect: 'error', body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`UX reasoner HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 250_000) throw new Error('UX reasoner response exceeded 250 KB');
    return responseSchema.parse(JSON.parse(text)).opportunities;
  }
}
