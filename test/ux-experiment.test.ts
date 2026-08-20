import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateUxExperiment } from '../src/ux/ux-experiment.js';
import { planUxExperiments } from '../src/ux/ux-experiment-planner.js';
import { UxLearningStore } from '../src/ux/ux-learning-store.js';
import type { UxOpportunity } from '../src/ux/ux-types.js';

const control = { id: 'control', sampleSize: 40, uxScore: 70, completionRate: 0.7, medianActions: 8, backtracksPerTask: 2, errorRate: 0.08 };

describe('M10 UX experiments', () => {
  it('selects a strong variant only when effect/confidence and guardrails agree', () => {
    const result = evaluateUxExperiment(control, [
      { id: 'better', sampleSize: 40, uxScore: 82, completionRate: 0.84, medianActions: 5, backtracksPerTask: 1, errorRate: 0.04 },
      { id: 'worse', sampleSize: 40, uxScore: 85, completionRate: 0.62, medianActions: 4, backtracksPerTask: 1, errorRate: 0.12 },
    ]);
    expect(result.winner).toBe('better');
    expect(result.variants.find((item) => item.id === 'better')?.decision).toBe('improved');
    expect(result.variants.find((item) => item.id === 'worse')).toMatchObject({ decision: 'regressed', guardrailViolation: true });
  });

  it('marks tiny samples inconclusive instead of pretending statistical certainty', () => {
    const result = evaluateUxExperiment({ ...control, sampleSize: 2 }, [{ ...control, id: 'variant', sampleSize: 2, uxScore: 95, completionRate: 0.95 }]);
    expect(result.variants[0]?.decision).toBe('inconclusive');
    expect(result.winner).toBeUndefined();
  });

  it('turns UX opportunities into measurable hypotheses', () => {
    const item: UxOpportunity = {
      id: 'op-1', category: 'efficiency', impact: 'high', confidence: 0.9, title: 'Too many steps', observation: '8 steps',
      recommendation: 'Add a contextual shortcut', expectedEffect: 'Reduce task steps', metric: 'steps:8', source: 'deterministic',
    };
    const planned = planUxExperiments([item])[0]!;
    expect(planned.primaryMetric).toBe('task-actions');
    expect(planned.hypothesis).toContain('Reduce task steps'.toLowerCase());
  });

  it('keeps learning read-only until an explicit baseline save', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-ux-memory-'));
    const store = new UxLearningStore(path.join(dir, 'ux.json'));
    expect(await store.compare('product/a', 80)).toMatchObject({ status: 'untracked', currentScore: 80 });
    await store.saveBaseline('product/a', 70, ['op-1']);
    expect(await store.compare('product/a', 80)).toMatchObject({ status: 'improved', baselineScore: 70, delta: 10 });
    expect(await store.compare('product/a', 62)).toMatchObject({ status: 'regressed', baselineScore: 70, delta: -8 });
  });
});
