import { describe, expect, it } from 'vitest';
import type { QaRunResult } from '../src/core/types.js';
import { verifyBeta10Dogfood } from '../src/verification/beta10-dogfood-verifier.js';

function result(): QaRunResult {
  return {
    runId: 'run-1',
    startedAt: '2026-08-21T00:00:00.000Z',
    finishedAt: '2026-08-21T00:01:00.000Z',
    visitedUrls: [
      'http://127.0.0.1:5173/',
      'http://127.0.0.1:5173/component-test',
      'http://127.0.0.1:5173/system-status',
    ],
    actions: 20,
    events: [],
    findings: [{
      id: 'BUG-0001', kind: 'ui', severity: 'medium', title: 'Visible text is clipped',
      url: 'http://127.0.0.1:5173/component-test', message: 'clipped fixture', reproduction: ['open'],
      evidence: ['/tmp/run/screenshot.png'], fingerprint: 'fp-1',
    }],
    findingClusters: {
      rawFindings: 1,
      clusters: 1,
      duplicateFindings: 0,
      items: [{
        id: 'CLUSTER-0001', key: 'key', title: 'Visible text is clipped', verdict: 'potential-product-defect',
        severity: 'medium', representativeFindingId: 'BUG-0001', memberFindingIds: ['BUG-0001'],
        memberFingerprints: ['fp-1'], routes: ['/component-test'], evidence: ['/tmp/run/screenshot.png'], duplicateCount: 0,
      }],
    },
    coverage: {
      score: 90,
      pageCoverage: 100,
      interactionCoverage: 70,
      rawInteractionCoverage: 70,
      eligibleInteractionCoverage: 85,
      discoveredInteractions: 20,
      allowedInteractions: 18,
      eligibleInteractions: 13,
      exercisedEligibleInteractions: 11,
      explainedEligibleGaps: 2,
      unexplainedEligibleGaps: 0,
      gapReasonCounts: { 'budget-exhausted': 2 },
      pages: [],
      gaps: [],
      terminalGaps: [],
    },
    planner: {
      configured: false,
      status: 'not-configured',
      pagesObserved: 3,
      pagesAttempted: 0,
      pagesModelUsed: 0,
      pagesFallback: 0,
      repairAttempts: 0,
      failedCalls: 0,
      providers: [],
    },
    visualBaseline: { enabled: false, existed: false, newSignals: 0, persistentSignals: 0, resolvedSignals: 0, updated: false },
    api: { enabled: false, mode: 'off', operationsDiscovered: 0, operationsTested: 0, operationsSkipped: 0 },
    correlation: { chains: 0, highConfidence: 0, apiMatched: 0, browserNetworkFailures: 0 },
    semanticState: { enabled: false, apiFactsObserved: 0, uiFieldsObserved: 0, comparisons: 0, matches: 0, mismatches: 0, ambiguousSkipped: 0 },
    device: {
      enabled: false, mode: 'off', sessionStarted: false, screenshotCaptured: false, pageSourceChars: 0,
      elementEstimate: 0, candidatesObserved: 0, blockedCandidates: 0, outsideAppCandidates: 0,
      appBoundaryDeclared: false, appBoundaryObserved: false, appStateChecks: 0, appTerminationFindings: 0,
      crashDialogFindings: 0, logOracleEnabled: false, logChecks: 0, logCrashFindings: 0, actions: 0,
      cleanupAttempted: false, cleanupFailed: false,
    },
    ux: {
      enabled: false, pagesAttempted: 0, pagesAnalyzed: 0, pagesFailed: 0, completeness: 0, valid: false,
      score: 0, opportunities: 0, highImpact: 0, mediumImpact: 0, lowImpact: 0,
      reasonerStatus: { configured: false, attempted: false, used: false, repairAttempted: false, fallbackUsed: false, outcome: 'not-configured' },
      reasonerUsed: false,
    },
    report: { enabled: true, htmlPath: '/tmp/run/report/index.html', dataPath: '/tmp/run/report/report-data.json', markdownPath: '/tmp/run/report/executive-summary.md', videos: 3, findings: 1, uxOpportunities: 0 },
    outputDir: '/tmp/run',
  };
}

function reportData() {
  return {
    run: { pageCoverage: 100, rawInteractionCoverage: 70, eligibleInteractionCoverage: 85, unexplainedEligibleGaps: 0 },
    findings: [{}],
    findingClusters: { rawFindings: 1, clusters: 1 },
  };
}

describe('Beta.10 dogfood verifier', () => {
  it('passes a deterministic heuristic dogfood result with consistent report metrics', () => {
    const verification = verifyBeta10Dogfood(result(), {
      requiredPaths: ['/', '/component-test', '/system-status'],
      reportData: reportData(),
    });
    expect(verification.status).toBe('PASS');
    expect(verification.checks.every((item) => item.status === 'pass')).toBe(true);
  });

  it('blocks rather than pretending success when model-required dogfood has no configured model', () => {
    const verification = verifyBeta10Dogfood(result(), {
      requiredPaths: ['/', '/component-test', '/system-status'],
      reportData: reportData(),
      requireModel: true,
    });
    expect(verification.status).toBe('BLOCKED');
    expect(verification.checks).toContainEqual(expect.objectContaining({ id: 'planner-model', status: 'blocked' }));
  });

  it('accepts visible partial fallback and explicit UX reasoner failure diagnostics when model dogfood requires observability', () => {
    const candidate = result();
    candidate.planner = {
      configured: true, status: 'partial-fallback', pagesObserved: 3, pagesAttempted: 3, pagesModelUsed: 2,
      pagesFallback: 1, repairAttempts: 1, failedCalls: 1, providers: ['minimax:MiniMax-M3'],
    };
    candidate.ux!.reasonerStatus = {
      configured: true, attempted: true, used: false, repairAttempted: false, fallbackUsed: true,
      outcome: 'fallback', error: 'schema-invalid', provider: 'minimax:MiniMax-M3',
    };
    const verification = verifyBeta10Dogfood(candidate, {
      requiredPaths: ['/', '/component-test', '/system-status'],
      reportData: reportData(),
      requireModel: true,
      requireUxReasoner: true,
    });
    expect(verification.status).toBe('PASS');
    expect(verification.metrics.plannerStatus).toBe('partial-fallback');
    expect(verification.metrics.uxReasonerOutcome).toBe('fallback');
  });

  it('fails release acceptance for missing routes, low eligible coverage, or inconsistent report metrics', () => {
    const candidate = result();
    candidate.coverage.eligibleInteractionCoverage = 62;
    const verification = verifyBeta10Dogfood(candidate, {
      requiredPaths: ['/', '/component-test', '/system-status', '/missing'],
      reportData: { ...reportData(), run: { ...reportData().run, eligibleInteractionCoverage: 99 } },
    });
    expect(verification.status).toBe('FAIL');
    expect(verification.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'route-coverage', status: 'fail' }),
      expect.objectContaining({ id: 'eligible-interaction-coverage', status: 'fail' }),
      expect.objectContaining({ id: 'report-metric-consistency', status: 'fail' }),
    ]));
  });
});
