import { z } from 'zod';
import type { PlannerModel, PlannerModelContext, PlannerModelRecommendation } from '../planning/planner-model.js';

const responseSchema = z.object({
  recommendations: z.array(z.object({
    candidateId: z.string().min(1),
    scoreDelta: z.number().finite(),
    reason: z.string().max(500).optional(),
  })).max(200),
});

export class HttpPlannerModel implements PlannerModel {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly timeoutMs = 8_000,
  ) {}

  async recommend(context: PlannerModelContext): Promise<PlannerModelRecommendation[]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: 1, context }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`planner model HTTP ${response.status}`);
    }

    const parsed = responseSchema.parse(await response.json());
    return parsed.recommendations;
  }
}
