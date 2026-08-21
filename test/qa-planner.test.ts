import { describe, expect, it } from 'vitest';
import { CoverageGraph } from '../src/planning/coverage-graph.js';
import { QaPlanner } from '../src/planning/qa-planner.js';
import type { ExplorationCandidate } from '../src/core/types.js';
import type { PlannerModel } from '../src/planning/planner-model.js';

const candidates: ExplorationCandidate[] = [
  {
    id: 'button:0:Delete account',
    kind: 'button',
    label: 'Delete account',
    locatorIndex: 0,
    tagName: 'button',
    type: 'button',
  },
  {
    id: 'link:1:Settings',
    kind: 'link',
    label: 'Settings',
    href: 'https://example.com/settings',
    locatorIndex: 1,
    tagName: 'a',
  },
  {
    id: 'link:2:Home',
    kind: 'link',
    label: 'Home',
    href: 'https://example.com/',
    locatorIndex: 2,
    tagName: 'a',
  },
];

describe('QaPlanner', () => {
  it('prioritizes safe novel coverage and places blocked controls last', async () => {
    const graph = new CoverageGraph();
    graph.visitPage('https://example.com/', 0);
    const ranking = await new QaPlanner(graph).rank('https://example.com/', 0, candidates, 'safe');

    expect(ranking.plans[0]?.candidate.label).toBe('Settings');
    expect(ranking.plans.at(-1)?.candidate.label).toBe('Delete account');
    expect(ranking.plans.at(-1)?.decision.allowed).toBe(false);
    expect(ranking.modelStatus).toMatchObject({
      configured: false,
      attempted: false,
      used: false,
      fallbackUsed: false,
      outcome: 'not-configured',
    });
  });

  it('lets a model reprioritize safe candidates but never unlock blocked actions', async () => {
    const model: PlannerModel = {
      async recommend() {
        return [
          { candidateId: 'link:2:Home', scoreDelta: 1000, reason: 'model wants to revisit home' },
          { candidateId: 'link:1:Settings', scoreDelta: -1000, reason: 'deprioritize settings for this scenario' },
          { candidateId: 'button:0:Delete account', scoreDelta: 1000, reason: 'must be ignored by safety gate' },
        ];
      },
    };

    const graph = new CoverageGraph();
    graph.visitPage('https://example.com/', 0);
    const ranking = await new QaPlanner(graph, undefined, model).rank('https://example.com/', 0, candidates, 'safe');

    expect(ranking.modelUsed).toBe(true);
    expect(ranking.modelStatus).toMatchObject({
      configured: true,
      attempted: true,
      used: true,
      fallbackUsed: false,
      outcome: 'used',
    });
    expect(ranking.plans[0]?.candidate.label).toBe('Home');
    const blocked = ranking.plans.find((plan) => plan.candidate.label === 'Delete account');
    expect(blocked?.decision.allowed).toBe(false);
    expect(blocked?.score).toBe(-1000);
  });

  it('falls back to heuristic ordering when the model fails and preserves the diagnostic', async () => {
    const model: PlannerModel = {
      async recommend() {
        throw new Error('model unavailable');
      },
    };
    const graph = new CoverageGraph();
    graph.visitPage('https://example.com/', 0);
    const ranking = await new QaPlanner(graph, undefined, model).rank('https://example.com/', 0, candidates, 'safe');
    expect(ranking.modelUsed).toBe(false);
    expect(ranking.modelError).toContain('model unavailable');
    expect(ranking.modelStatus).toMatchObject({
      configured: true,
      attempted: true,
      used: false,
      fallbackUsed: true,
      outcome: 'fallback',
    });
    expect(ranking.modelStatus.error).toContain('model unavailable');
    expect(ranking.plans[0]?.candidate.label).toBe('Settings');
  });

  it('reports a configured model as explicitly skipped when there are no candidates', async () => {
    const model: PlannerModel = {
      async recommend() {
        throw new Error('should not be called');
      },
    };
    const graph = new CoverageGraph();
    const ranking = await new QaPlanner(graph, undefined, model).rank('https://example.com/empty', 0, [], 'safe');
    expect(ranking.modelStatus).toMatchObject({
      configured: true,
      attempted: false,
      used: false,
      fallbackUsed: false,
      outcome: 'skipped',
    });
    expect(ranking.modelStatus.skipReason).toContain('no planner candidates');
  });
});
