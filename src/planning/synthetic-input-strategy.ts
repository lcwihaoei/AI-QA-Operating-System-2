import type { ExplorationCandidate } from '../core/types.js';

export type SyntheticFieldPlan =
  | { action: 'fill'; value: string; reason: string }
  | { action: 'select'; reason: string }
  | { action: 'skip'; reason: string };

export class SyntheticInputStrategy {
  plan(candidate: ExplorationCandidate): SyntheticFieldPlan {
    const tag = candidate.tagName.toLowerCase();
    const type = (candidate.type || 'text').toLowerCase();

    if (tag === 'select') return { action: 'select', reason: 'exercise a non-destructive select state with synthetic choice' };
    if (tag === 'textarea') return { action: 'fill', value: 'AI QA exploratory input', reason: 'synthetic multiline text' };

    if (tag !== 'input') return { action: 'skip', reason: `unsupported field tag: ${tag}` };

    switch (type) {
      case 'text':
        return { action: 'fill', value: 'AI QA test', reason: 'synthetic text value' };
      case 'search':
        return { action: 'fill', value: 'qa exploratory test', reason: 'synthetic search query' };
      case 'email':
        return { action: 'fill', value: 'qa@example.com', reason: 'synthetic RFC-style email address' };
      case 'url':
        return { action: 'fill', value: 'https://example.com', reason: 'synthetic URL' };
      case 'tel':
        return { action: 'fill', value: '5550100123', reason: 'synthetic telephone number' };
      case 'number':
      case 'range':
        return { action: 'fill', value: '42', reason: 'synthetic numeric value' };
      case 'date':
        return { action: 'fill', value: '2030-01-15', reason: 'synthetic date' };
      case 'datetime-local':
        return { action: 'fill', value: '2030-01-15T12:00', reason: 'synthetic local date/time' };
      case 'time':
        return { action: 'fill', value: '12:00', reason: 'synthetic time' };
      case 'password':
        return { action: 'fill', value: 'Qa-Test-123!', reason: 'synthetic password; never sourced from user credentials' };
      default:
        return { action: 'skip', reason: `unsupported or stateful input type: ${type}` };
    }
  }
}
