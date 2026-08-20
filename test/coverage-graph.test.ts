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
  it('tracks page and interaction coverage independently', () => {
    const graph = new CoverageGraph();
    graph.discoverPage('https://example.com/', 0);
    graph.visitPage('https://example.com/', 0);
    graph.discoverPage('https://example.com/settings', 1);
    graph.discoverCandidate('https://example.com/', link, 'low', true);

    let snapshot = graph.snapshot();
    expect(snapshot.pageCoverage).toBe(50);
    expect(snapshot.interactionCoverage).toBe(0);
    expect(snapshot.gaps.some((gap) => gap.includes('Unvisited page'))).toBe(true);

    graph.markCandidateExercised('https://example.com/', link.id);
    graph.visitPage('https://example.com/settings', 1);
    snapshot = graph.snapshot();
    expect(snapshot.pageCoverage).toBe(100);
    expect(snapshot.interactionCoverage).toBe(100);
    expect(snapshot.score).toBe(100);
  });

  it('does not punish coverage for intentionally blocked controls', () => {
    const graph = new CoverageGraph();
    graph.visitPage('https://example.com/', 0);
    graph.discoverCandidate('https://example.com/', { ...link, id: 'delete', label: 'Delete account' }, 'blocked', false);
    const snapshot = graph.snapshot();
    expect(snapshot.interactionCoverage).toBe(100);
    expect(snapshot.pages[0]?.blockedCandidates).toBe(1);
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
});
