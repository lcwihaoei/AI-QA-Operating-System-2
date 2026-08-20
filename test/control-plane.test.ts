import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlaneStore } from '../src/control/control-plane.js';
import { dashboardHtml, isLoopbackHost, startDashboard } from '../src/control/dashboard-server.js';
import type { QaRunResult } from '../src/core/types.js';

const servers: Array<{ close(cb: () => void): void }> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve)))); });

function qaResult(): QaRunResult {
  return {
    runId: 'run-1', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', visitedUrls: ['https://example.test'], actions: 3,
    events: [], findings: [{ id: 'BUG-1', kind: 'assertion', severity: 'high', title: 'broken', url: 'https://example.test', message: 'broken', reproduction: [], evidence: [], fingerprint: 'f1' }],
    coverage: { score: 75, pageCoverage: 80, interactionCoverage: 70, pages: [], gaps: [] },
    visualBaseline: { enabled: false, existed: false, newSignals: 0, persistentSignals: 0, resolvedSignals: 0, updated: false },
    api: { enabled: false, mode: 'off', operationsDiscovered: 0, operationsTested: 0, operationsSkipped: 0 },
    correlation: { chains: 0, highConfidence: 0, apiMatched: 0, browserNetworkFailures: 0 },
    semanticState: { enabled: false, apiFactsObserved: 0, uiFieldsObserved: 0, comparisons: 0, matches: 0, mismatches: 0, ambiguousSkipped: 0 },
    device: { enabled: false, mode: 'off', sessionStarted: false, screenshotCaptured: false, pageSourceChars: 0, elementEstimate: 0, candidatesObserved: 0, blockedCandidates: 0, outsideAppCandidates: 0, appBoundaryDeclared: false, appBoundaryObserved: false, appStateChecks: 0, appTerminationFindings: 0, crashDialogFindings: 0, logOracleEnabled: false, logChecks: 0, logCrashFindings: 0, actions: 2, cleanupAttempted: false, cleanupFailed: false },
    outputDir: '.qa-runs/run-1',
  };
}

describe('ControlPlaneStore', () => {
  it('records bounded run summaries without copying raw event evidence', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-control-'));
    const store = new ControlPlaneStore(path.join(dir, 'state.json'));
    await store.recordRun(qaResult());
    const state = await store.load();
    expect(state.runs[0]).toMatchObject({ runId: 'run-1', coverageScore: 75, visited: 1, browserActions: 3, deviceActions: 2 });
    expect(JSON.stringify(state)).not.toContain('broken');
  });

  it('leases jobs only to workers with required capabilities and respects priority', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-control-'));
    const store = new ControlPlaneStore(path.join(dir, 'state.json'));
    await store.heartbeat('worker-1', ['browser', 'android']);
    await store.enqueue({ project: 'p', url: 'https://low.test', requiredCapabilities: ['browser'], priority: 1 });
    const high = await store.enqueue({ project: 'p', url: 'https://high.test', requiredCapabilities: ['browser', 'android'], priority: 10 });
    expect((await store.lease('worker-1'))?.id).toBe(high.id);
    await store.complete('worker-1', high.id, true);
    expect((await store.load()).jobs.find((job) => job.id === high.id)?.status).toBe('completed');
  });
});

describe('dashboard', () => {
  it('is loopback-safe and has a read-only UI', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(dashboardHtml()).toContain('Read-only operational view');
  });

  it('requires a token for remote binding before opening a socket', async () => {
    const store = new ControlPlaneStore('/tmp/does-not-matter.json');
    await expect(startDashboard(store, { host: '0.0.0.0', port: 0 })).rejects.toThrow(/token/);
  });
});
