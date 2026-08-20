import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkPlan } from '../src/planning/work-item.js';
import { ControlPlaneStore } from '../src/control/control-plane.js';
import { startDashboard } from '../src/control/dashboard-server.js';

const roots: string[] = [];
const servers: Array<{ close(callback: () => void): void }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function plan(): WorkPlan {
  const execution = { mutationAllowed: false, allowedPaths: [], forbiddenPaths: [], maxAttempts: 1, requireCleanWorkspace: true, requireIsolatedBranch: true, requireTargetedTests: true, requireRegressionTests: true, requireBeta7Qa: true };
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), project: 'demo', purpose: 'handoff', items: [
      { id: 'B8-DONE', kind: 'backend', title: 'done', goal: 'done', why: 'test', source: [{ type: 'frontend-discovery', reference: 'fixture' }], status: 'completed', priority: 'P1', confidence: 1, dependencies: [], affectedModules: [], affectedFiles: [], designRequirements: [], implementationPlan: [], securityImpact: [], risks: [], acceptanceCriteria: [], requiredTests: [], qaStrategy: [], approval: { required: true, approved: false }, execution: { ...execution } },
      { id: 'B8-QA-001', kind: 'qa', title: 'qa', goal: 'qa', why: 'test', source: [{ type: 'frontend-discovery', reference: 'fixture' }], status: 'planned', priority: 'P1', confidence: 1, dependencies: ['B8-DONE'], affectedModules: [], affectedFiles: [], designRequirements: [], implementationPlan: [], securityImpact: [], risks: [], acceptanceCriteria: [], requiredTests: [], qaStrategy: [], approval: { required: true, approved: false }, execution: { ...execution } },
    ],
  };
}

async function fixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta8-qa-http-'));
  roots.push(repo);
  const artifacts = path.join(repo, '.qa-backend');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'work-plan.json'), `${JSON.stringify(plan(), null, 2)}\n`);
  const result = {
    runId: 'beta8-final-run', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    findings: [
      { id: 'f-high', kind: 'ui', severity: 'high', title: 'High visible regression', url: 'http://127.0.0.1/app', message: 'bad', reproduction: ['open'], evidence: ['shot.png'], fingerprint: 'fp-high' },
      { id: 'f-low', kind: 'ui', severity: 'low', title: 'Minor polish', url: 'http://127.0.0.1/app', message: 'minor', reproduction: ['open'], evidence: ['shot2.png'], fingerprint: 'fp-low' },
    ],
    report: { enabled: true, htmlPath: path.join(repo, '.qa-runs/beta8-final-run/report/index.html'), videos: 1, findings: 2, uxOpportunities: 0 },
  };
  const payload = JSON.stringify(result);
  await writeFile(path.join(repo, 'qa.cjs'), `const fs=require('fs');fs.mkdirSync('.qa-runs/beta8-final-run',{recursive:true});fs.writeFileSync('.qa-runs/beta8-final-run/result.json',${JSON.stringify(payload)});`);
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'qa-http', private: true, scripts: { qa: 'node qa.cjs' } }));
  return { repo, artifacts, beta9Plan: path.join(repo, '.qa-beta9', 'plan.json') };
}

async function post(base: string, endpoint: string, body: unknown) {
  const response = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as any };
}

describe('Beta.8 final QA dashboard handoff', () => {
  it('runs one final Beta.7 result and makes it the dynamic source for Beta.9 selection/actions', async () => {
    const { repo, artifacts, beta9Plan } = await fixture();
    const started = await startDashboard(new ControlPlaneStore(path.join(repo, '.qa-control/state.json')), {
      host: '127.0.0.1', port: 0, allowActions: true, beta8RepoPath: repo, beta8ArtifactRoot: artifacts, beta9PlanPath: beta9Plan,
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;

    const run = await post(base, '/api/beta8/run-final-qa', { command: { program: 'npm', args: ['run', 'qa'] } });
    expect(run.status).toBe(200);
    expect(run.json.qa).toMatchObject({ runId: 'beta8-final-run', blockingFindings: 1 });

    const beta8 = await fetch(`${base}/api/beta8`).then((response) => response.json() as Promise<any>);
    expect(beta8.finalQa.findings.total).toBe(2);
    expect(beta8.finalQa.qa.report.html).toContain('.qa-runs/beta8-final-run/report/index.html');

    const handoff = await post(base, '/api/beta8/send-findings-beta9', { fingerprints: ['fp-high'], project: 'Beta.8 final QA' });
    expect(handoff.status).toBe(201);
    expect(handoff.json).toMatchObject({ available: true, sourceRunId: 'beta8-final-run', selected: 1 });

    const beta9 = await fetch(`${base}/api/beta9`).then((response) => response.json() as Promise<any>);
    expect(beta9).toMatchObject({ available: true, sourceRunId: 'beta8-final-run', selected: 1 });
    const source = await fetch(`${base}/api/beta9/findings`).then((response) => response.json() as Promise<any>);
    expect(source.available).toBe(true);
    expect(source.findings.find((finding: any) => finding.fingerprint === 'fp-high').selected).toBe(true);

    const js = await fetch(`${base}/beta8-qa-dashboard.js`);
    const css = await fetch(`${base}/beta8-qa-dashboard.css`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('send-findings-beta9');
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('#beta8QaWorkflow');
  }, 25_000);
});
