import { createHash } from 'node:crypto';
import type { UxOpportunity } from './ux-types.js';

export interface UxExperimentHypothesis {
  id: string;
  opportunityId: string;
  hypothesis: string;
  primaryMetric: 'completion-rate' | 'task-actions' | 'backtracks' | 'error-rate' | 'ux-score';
  guardrails: string[];
}

export function planUxExperiments(opportunities: UxOpportunity[]): UxExperimentHypothesis[] {
  return opportunities.slice(0, 30).map((item) => {
    const primaryMetric: UxExperimentHypothesis['primaryMetric'] = item.category === 'efficiency'
      ? 'task-actions'
      : item.category === 'discoverability' || item.category === 'first-time-experience'
        ? 'completion-rate'
        : item.category === 'accessibility'
          ? 'error-rate'
          : item.category === 'cognitive-load'
            ? 'backtracks'
            : 'ux-score';
    const hypothesis = `If we apply the recommendation for “${item.title}”, then ${item.expectedEffect.toLowerCase()} without increasing task errors.`;
    const id = createHash('sha1').update(`${item.id}|${primaryMetric}|${item.recommendation}`).digest('hex').slice(0, 14);
    return {
      id,
      opportunityId: item.id,
      hypothesis,
      primaryMetric,
      guardrails: ['completion rate must not decrease by more than 3 percentage points', 'error rate must not increase by more than 2 percentage points'],
    };
  });
}
