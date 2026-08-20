import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlaneStore } from '../src/control/control-plane.js';
import { dashboardCss, dashboardHtml, dashboardJs, isLoopbackHost, startDashboard } from '../src/control/dashboard-server.js';
import type { QaRunResult } from '../src/core/types.js';
import { buildBeta9Plan } from '../src/fix/beta9-planner.js';

const servers: Array<{ close(cb: () => void): void }> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve)))); });

function qaResult(): QaRunResult {
  return {
    runId: 'run-1', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', visitedUrls: ['https://example.test'], actions: 3,
    events: [], findings: [{ id: 'BUG-1', kind: 'assertion', severity: 'high', title: 'broken', url: 'https://example.test', message: 'broken', reproduction: ['open page'], evidence: ['secret-ish-evidence-path'], fingerprint: 'f1' }],
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

describe('management dashboard shell', () => {
  it('keeps loopback safety while exposing the beta8/beta9 bilingual responsive shell', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    const html = dashboardHtml();
    const css = dashboardCss();
    const js = dashboardJs();
    expect(html).toContain('AI QA Operating System');
    expect(html).toContain('data-locale="zh-TW"');
    expect(html).toContain('data-locale="en"');
    expect(html).toContain('data-page="beta8"');
    expect(html).toContain('data-page="beta9"');
    expect(html).toContain('/dashboard.css');
    expect(html).toContain('/dashboard.js');
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).toContain('@media(max-width:900px)');
    expect(js).toContain("'zh-TW'");
    expect(js).toContain('aiqa.dashboard.theme');
    expect(js).toContain('aiqa.dashboard.locale');
    expect(js).toContain("return lang.indexOf('zh-tw')===0");
  });

  it('requires a token for remote binding and refuses remote action mode before opening a socket', async () => {
    const store = new ControlPlaneStore('/tmp/does-not-matter.json');
    await expect(startDashboard(store, { host: '0.0.0.0', port: 0 })).rejects.toThrow(/token/);
    await expect(startDashboard(store, { host: '0.0.0.0', port: 0, token: 'test-token', allowActions: true })).rejects.toThrow(/loopback-only/);
  });

  it('serves external dashboard assets under a CSP without unsafe-inline', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-dashboard-'));
    const store = new ControlPlaneStore(path.join(dir, 'state.json'));
    const started = await startDashboard(store, { host: '127.0.0.1', port: 0, beta9PlanPath: path.join(dir, 'missing-beta9.json') });
    servers.push(started.server);
    const root = await fetch(`http://127.0.0.1:${started.port}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-security-policy')).not.toContain('unsafe-inline');
    const rootText = await root.text();
    expect(rootText).toContain('AI QA Operating System');
    expect(rootText).toContain('/beta9-dashboard.js');
    const css = await fetch(`http://127.0.0.1:${started.port}/dashboard.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('.mobile-nav');
    const js = await fetch(`http://127.0.0.1:${started.port}/dashboard.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toContain('function setLocale');
    const beta9Js = await fetch(`http://127.0.0.1:${started.port}/beta9-dashboard.js`);
    expect(beta9Js.headers.get('content-type')).toContain('text/javascript');
    const beta9JsText = await beta9Js.text();
    expect(beta9JsText).toContain("fetch('/api/beta9'");
    expect(beta9JsText).toContain("fetch('/api/beta9/select'");
    const beta9 = await fetch(`http://127.0.0.1:${started.port}/api/beta9`);
    expect(await beta9.json()).toEqual({ available: false });
  });

  it('exposes only a bounded validated Beta.9 plan summary through the read-only endpoint', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-dashboard-beta9-'));
    const planPath = path.join(dir, 'plan.json');
    const plan = buildBeta9Plan({ result: qaResult(), selectedFingerprints: ['f1'], project: 'dashboard-fixture' });
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const started = await startDashboard(new ControlPlaneStore(path.join(dir, 'state.json')), { host: '127.0.0.1', port: 0, beta9PlanPath: planPath });
    servers.push(started.server);
    const response = await fetch(`http://127.0.0.1:${started.port}/api/beta9`);
    expect(response.status).toBe(200);
    const summary = await response.json() as { available: boolean; selected: number; project: string; items: Array<Record<string, unknown>> };
    expect(summary.available).toBe(true);
    expect(summary.selected).toBe(1);
    expect(summary.project).toBe('dashboard-fixture');
    expect(summary.items[0]).toMatchObject({ title: 'broken', severity: 'high', kind: 'assertion', status: 'planned', approved: false, mutationAllowed: false, affectedFiles: 0, allowedPaths: 0 });
    expect(JSON.stringify(summary)).not.toContain('secret-ish-evidence-path');
    expect(JSON.stringify(summary)).not.toContain('open page');
    expect(JSON.stringify(summary)).not.toContain('message');
  });

  it('keeps finding selection read-only by default and creates a plan only in explicit same-origin loopback action mode', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-dashboard-select-'));
    const resultPath = path.join(dir, 'result.json');
    const planPath = path.join(dir, 'plan.json');
    await writeFile(resultPath, `${JSON.stringify(qaResult(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

    const readOnly = await startDashboard(new ControlPlaneStore(path.join(dir, 'readonly-state.json')), {
      host: '127.0.0.1', port: 0, beta7ResultPath: resultPath, beta9PlanPath: planPath,
    });
    servers.push(readOnly.server);
    const candidates = await (await fetch(`http://127.0.0.1:${readOnly.port}/api/beta9/findings`)).json() as { actionsAllowed: boolean; findings: Array<Record<string, unknown>> };
    expect(candidates.actionsAllowed).toBe(false);
    expect(candidates.findings[0]).toMatchObject({ fingerprint: 'f1', title: 'broken', severity: 'high', selected: false });
    expect(JSON.stringify(candidates)).not.toContain('secret-ish-evidence-path');
    const denied = await fetch(`http://127.0.0.1:${readOnly.port}/api/beta9/select`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fingerprints: ['f1'] }),
    });
    expect(denied.status).toBe(403);

    const actionDir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-dashboard-action-'));
    const actionResult = path.join(actionDir, 'result.json');
    const actionPlan = path.join(actionDir, 'plan.json');
    await writeFile(actionResult, `${JSON.stringify(qaResult(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const writable = await startDashboard(new ControlPlaneStore(path.join(actionDir, 'state.json')), {
      host: '127.0.0.1', port: 0, beta7ResultPath: actionResult, beta9PlanPath: actionPlan, allowActions: true,
    });
    servers.push(writable.server);
    const enabled = await (await fetch(`http://127.0.0.1:${writable.port}/api/beta9/findings`)).json() as { actionsAllowed: boolean };
    expect(enabled.actionsAllowed).toBe(true);
    const crossSite = await fetch(`http://127.0.0.1:${writable.port}/api/beta9/select`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ fingerprints: ['f1'] }),
    });
    expect(crossSite.status).toBe(403);
    const created = await fetch(`http://127.0.0.1:${writable.port}/api/beta9/select`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ fingerprints: ['f1'], project: 'dashboard-selected' }),
    });
    expect(created.status).toBe(201);
    const createdSummary = await created.json() as { available: boolean; selected: number; project: string };
    expect(createdSummary).toMatchObject({ available: true, selected: 1, project: 'dashboard-selected' });
    const after = await (await fetch(`http://127.0.0.1:${writable.port}/api/beta9/findings`)).json() as { actionsAllowed: boolean; findings: Array<Record<string, unknown>> };
    expect(after.actionsAllowed).toBe(false);
    expect(after.findings[0]).toMatchObject({ fingerprint: 'f1', selected: true });
    const overwrite = await fetch(`http://127.0.0.1:${writable.port}/api/beta9/select`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ fingerprints: ['f1'] }),
    });
    expect(overwrite.status).toBe(409);
  });
});
