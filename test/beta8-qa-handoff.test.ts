import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkPlan } from '../src/planning/work-item.js';
import { Beta8QaHandoffService } from '../src/control/beta8-qa-handoff-service.js';

const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

function workPlan(): WorkPlan {
  const execution = { mutationAllowed: false, allowedPaths: [], forbiddenPaths: [], maxAttempts: 1, requireCleanWorkspace: true, requireIsolatedBranch: true, requireTargetedTests: true, requireRegressionTests: true, requireBeta7Qa: true };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: 'demo',
    purpose: 'Beta.8 test',
    items: [
      {
        id: 'B8-FND-001', kind: 'infrastructure', title: 'foundation', goal: 'foundation', why: 'test', source: [{ type: 'frontend-discovery', reference: 'fixture' }], status: 'completed', priority: 'P0', confidence: 1,
        dependencies: [], affectedModules: ['platform'], affectedFiles: [], designRequirements: [], implementationPlan: [], securityImpact: [], risks: [], acceptanceCriteria: [], requiredTests: [], qaStrategy: [],
        approval: { required: true, approved: false }, execution: { ...execution },
      },
      {
        id: 'B8-QA-001', kind: 'qa', title: 'qa', goal: 'qa', why: 'test', source: [{ type: 'frontend-discovery', reference: 'fixture' }], status: 'planned', priority: 'P1', confidence: 1,
        dependencies: ['B8-FND-001'], affectedModules: ['beta7'], affectedFiles: [], designRequirements: [], implementationPlan: [], securityImpact: [], risks: [], acceptanceCriteria: [], requiredTests: [], qaStrategy: [],
        approval: { required: true, approved: false }, execution: { ...execution },
      },
    ],
  };
}

function result(runId: string, severity: 'critical' | 'high' | 'medium' | 'low' | 'info' = 'medium') {
  return {
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    findings: [{
      id: `${runId}-f1`, kind: 'ui', severity, title: 'Visible issue', url: 'http://127.0.0.1/app', message: 'Issue', reproduction: ['Open page'], evidence: ['screenshot.png'], fingerprint: `${runId}-fingerprint`,
    }],
    report: { enabled: true, htmlPath: `.qa-runs/${runId}/report/index.html`, markdownPath: `.qa-runs/${runId}/report/executive-summary.md`, videos: 1, findings: 1, uxOpportunities: 0 },
  };
}

async function fixture(mode: 'one' | 'two' = 'one') {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta8-qa-'));
  roots.push(repo);
  const artifacts = path.join(repo, '.qa-backend');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'work-plan.json'), `${JSON.stringify(workPlan(), null, 2)}\n`);
  const payload1 = JSON.stringify(result('run-final', 'medium'));
  const payload2 = JSON.stringify(result('run-ambiguous', 'low'));
  const qaScript = mode === 'one'
    ? `const fs=require('fs');fs.mkdirSync('.qa-runs/run-final',{recursive:true});fs.writeFileSync('.qa-runs/run-final/result.json',${JSON.stringify(payload1)});`
    : `const fs=require('fs');fs.mkdirSync('.qa-runs/run-final',{recursive:true});fs.writeFileSync('.qa-runs/run-final/result.json',${JSON.stringify(payload1)});fs.mkdirSync('.qa-runs/run-ambiguous',{recursive:true});fs.writeFileSync('.qa-runs/run-ambiguous/result.json',${JSON.stringify(payload2)});`;
  await writeFile(path.join(repo, 'qa.cjs'), qaScript);
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'qa-handoff-fixture', private: true, scripts: { qa: 'node qa.cjs' } }));
  return { repo, artifacts, beta9Plan: path.join(repo, '.qa-beta9', 'plan.json') };
}

describe('Beta8QaHandoffService', () => {
  it('runs an allowlisted final QA command, records exactly one fresh result, and hands selected findings to Beta.9', async () => {
    const { repo, artifacts, beta9Plan } = await fixture('one');
    const service = new Beta8QaHandoffService({ repoPath: repo, artifactRoot: artifacts, beta9PlanPath: beta9Plan });
    const before = await service.summary();
    expect(before.readyToRun).toBe(true);
    expect(before.available).toBe(false);

    const done = await service.run({ program: 'npm', args: ['run', 'qa'] });
    expect(done.available).toBe(true);
    expect(done.qa).toMatchObject({ runId: 'run-final', blockingFindings: 0 });
    expect(done.qa?.counts.medium).toBe(1);
    expect(done.findings?.findings?.[0]?.fingerprint).toBe('run-final-fingerprint');
    expect(done.qa?.report?.html).toContain('.qa-runs/run-final/report/index.html');

    const plan = await service.sendToBeta9(['run-final-fingerprint'], 'Beta.8 final QA');
    expect(plan).toMatchObject({ available: true, sourceRunId: 'run-final', selected: 1 });
    await expect(service.sendToBeta9(['run-final-fingerprint'])).rejects.toThrow(/already exists/i);
  }, 20_000);

  it('blocks final handoff rather than guessing when one QA command creates multiple fresh Beta.7 results', async () => {
    const { repo, artifacts, beta9Plan } = await fixture('two');
    const service = new Beta8QaHandoffService({ repoPath: repo, artifactRoot: artifacts, beta9PlanPath: beta9Plan });
    await expect(service.run({ program: 'npm', args: ['run', 'qa'] })).rejects.toThrow(/multiple new Beta\.7 results/i);
    const summary = await service.summary();
    expect(summary.available).toBe(false);
  }, 20_000);

  it('blocks final QA while implementation work remains incomplete', async () => {
    const { repo, artifacts } = await fixture('one');
    const plan = workPlan();
    plan.items[0]!.status = 'planned';
    await writeFile(path.join(artifacts, 'work-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const service = new Beta8QaHandoffService({ repoPath: repo, artifactRoot: artifacts });
    const summary = await service.summary();
    expect(summary.readyToRun).toBe(false);
    expect(summary.blockers.join(' ')).toMatch(/B8-FND-001/);
    await expect(service.run({ program: 'npm', args: ['run', 'qa'] })).rejects.toThrow(/blocked/i);
  });
});
