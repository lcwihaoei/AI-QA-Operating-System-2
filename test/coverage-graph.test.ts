import { describe, expect, it } from 'vitest';
import { CoverageGraph } from '../src/planning/coverage-graph.js';
import type { ExplorationCandidate } from '../src/core/types.js';

const link: ExplorationCandidate = {
  id: 'link:0:/settings',
  kind: 'link',
  label: 'Settings',
  href: 'https://example.com/settings',
  locatorIndex: 0,
  tagName: 'a',
};

describe('CoverageGraph', () => {
  it('tracks page, raw interaction and eligible interaction coverage independently', () => {
    const graph = new CoverageGraph();
    graph.discoverPage('https://example.com/', 0);
    graph.visitPage('https://example.com/', 0);
    graph.discoverPage('https://example.com/settings', 1);
    graph.discoverCandidate('https://example.com/', link, 'low', true);

    let snapshot = graph.snapshot();
    expect(snapshot.pageCoverage).toBe(50);
    expect(snapshot.interactionCoverage).toBe(0);
    expect(snapshot.rawInteractionCoverage).toBe(0);
    expect(snapshot.eligibleInteractionCoverage).toBe(0);
    expect(snapshot.eligibleInteractions).toBe(1);
    expect(snapshot.unexplainedEligibleGaps).toBe(1);
    expect(snapshot.gaps.some((gap) => gap.includes('Unvisited page'))).toBe(true);

    graph.markCandidateExercised('https://example.com/', link.id);
    graph.visitPage('https://example.com/settings', 1);
    snapshot = graph.snapshot();
    expect(snapshot.pageCoverage).toBe(100);
    expect(snapshot.interactionCoverage).toBe(100);
    expect(snapshot.eligibleInteractionCoverage).toBe(100);
    expect(snapshot.unexplainedEligibleGaps).toBe(0);
    expect(snapshot.score).toBe(100);
  });

  it('does not punish eligible coverage for intentionally blocked controls while preserving raw discovery counts', () => {
    const graph = new CoverageGraph();
    graph.visitPage('https://example.com/', 0);
    graph.discoverCandidate('https://example.com/', { ...link, id: 'delete', label: 'Delete account' }, 'blocked', false);
    const snapshot = graph.snapshot();
    expect(snapshot.interactionCoverage).toBe(100);
    expect(snapshot.eligibleInteractionCoverage).toBe(100);
    expect(snapshot.discoveredInteractions).toBe(1);
    expect(snapshot.allowedInteractions).toBe(0);
    expect(snapshot.eligibleInteractions).toBe(0);
    expect(snapshot.pages[0]?.blockedCandidates).toBe(1);
    expect(snapshot.gapReasonCounts?.['blocked-by-risk-policy']).toBe(1);
  });

  it('preserves a nested page depth while updating candidate and error state', () => {
    const graph = new CoverageGraph();
    graph.visitPage('https://example.com/settings', 3);
    graph.discoverCandidate('https://example.com/settings', link, 'low', true);
    graph.markPageError('https://example.com/settings');
    const page = graph.snapshot().pages[0];
    expect(page?.depth).toBe(3);
    expect(page?.errors).toBe(1);
  });

  it('keeps budget exhaustion inside eligible coverage but excludes legitimate duplicate navigation from the eligible denominator', () => {
    const graph = new CoverageGraph();
    graph.visitPage('https://example.com/', 0);
    graph.discoverCandidate('https://example.com/', link, 'low', true);
    graph.discoverCandidate('https://example.com/', { ...link, id: 'button:help', kind: 'button', label: 'Help', href: undefined, tagName: 'button' }, 'low', true);

    graph.markCandidateTerminal('https://example.com/', link.id, 'navigation-duplicate', 'target route already covered');
    let snapshot = graph.snapshot();
    expect(snapshot.eligibleInteractions).toBe(1);
    expect(snapshot.explainedEligibleGaps).toBe(0);
    expect(snapshot.unexplainedEligibleGaps).toBe(1);
    expect(snapshot.terminalGaps).toContainEqual(expect.objectContaining({
      candidateId: link.id,
      reason: 'navigation-duplicate',
      eligible: false,
      explained: true,
    }));

    graph.markRemainingEligibleTerminal('budget-exhausted', 'https://example.com/', 'global action budget');
    snapshot = graph.snapshot();
    expect(snapshot.explainedEligibleGaps).toBe(1);
    expect(snapshot.unexplainedEligibleGaps).toBe(0);
    expect(snapshot.eligibleInteractionCoverage).toBe(0);
    expect(snapshot.gapReasonCounts?.['budget-exhausted']).toBe(1);
  });

  it('clears a stale terminal explanation if the candidate is observed again in a fresh active state', () => {
    const graph = new CoverageGraph();
    graph.visitPage('https://example.com/', 0);
    graph.discoverCandidate('https://example.com/', link, 'low', true);
    graph.markCandidateTerminal('https://example.com/', link.id, 'stale-after-state-change');
    expect(graph.snapshot().eligibleInteractions).toBe(0);

    graph.discoverCandidate('https://example.com/', link, 'low', true);
    const snapshot = graph.snapshot();
    expect(snapshot.eligibleInteractions).toBe(1);
    expect(snapshot.unexplainedEligibleGaps).toBe(1);
  });
});
