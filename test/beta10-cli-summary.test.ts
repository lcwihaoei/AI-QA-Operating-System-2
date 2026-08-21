import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Beta.10 CLI operator summary', () => {
  it('surfaces canonical planner, UX reasoner, eligible coverage and cluster fields', async () => {
    const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(source).toContain('plannerExecution: result.planner');
    expect(source).toContain('uxReasonerExecution: result.ux?.reasonerStatus');
    expect(source).toContain('eligibleInteractionCoverage: result.coverage.eligibleInteractionCoverage');
    expect(source).toContain('unexplainedEligibleGaps: result.coverage.unexplainedEligibleGaps');
    expect(source).toContain('gapReasonCounts: result.coverage.gapReasonCounts');
    expect(source).toContain('findingClusters: clusterSummary');
  });
});
