import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding, QaRunResult } from '../src/core/types.js';
import { LocalGitBackendWorkspace } from '../src/backend/local-git-backend-workspace.js';
import { approveWorkItem } from '../src/planning/work-item.js';
import { Beta9FixExecutor } from '../src/fix/beta9-executor.js';
import { applyBeta9Correlation, correlateBeta9Attempt, prepareBeta9Retry } from '../src/fix/beta9-correlation.js';
import { Beta9FixPlanner, type Beta9FixPlanningModel } from '../src/fix/beta9-fix-plan.js';
import { buildBeta9Plan, validateBeta9Plan } from '../src/fix/beta9-planner.js';
import { LocalGitFixWorkspace } from '../src/fix/local-git-fix-workspace.js';

const exec = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true }); });

function finding(fingerprint = 'finding-123'): Finding {
  return {
    id: 'F-001', kind: 'ui', severity: 'high', title: 'Broken message card', url: 'http://127.0.0.1/messages',
    message: 'The message card renders the wrong label after refresh.',
    reproduction: ['Open /messages', 'Refresh', 'Observe wrong label'],
    evidence: ['screenshots/f-001.png', 'videos/f-001.webm'], fingerprint,
  };
}

function result(findings = [finding()], runId = 'run-beta7'): QaRunResult {
  return { runId, findings } as unknown as QaRunResult;
}

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'aiqa-beta9-'));
  cleanup.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'beta9-fixture', private: true,
    scripts: {
      test: 'node -e "process.exit(0)"',
      build: 'node -e "process.exit(0)"',
      qa: 'node -e "process.exit(0)"',
      'test:fail': 'node -e "process.exit(1)"',
    },
  }, null, 2));
  await exec('mkdir', ['-p', 'src'], { cwd: root });
  await writeFile(path.join(root, 'src/app.ts'), "export const message = 'wrong label';\n");
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'QA Test'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
  await exec('git', ['switch', '-c', 'feature/product-work'], { cwd: root });
  return root;
}

function model(failing = false): Beta9FixPlanningModel {
  return {
    async propose(context) {
      const source = context.files.find((file) => file.path === 'src/app.ts') ?? context.files[0]!;
      return {
        schemaVersion: 1,
        workItemId: context.workItem.id,
        findingFingerprint: context.finding.fingerprint,
        summary: 'Correct the label at its source and protect it with targeted regression coverage.',
        rootCause: 'The UI reads a stale constant instead of the expected label.',
        recommendedChange: ['Replace the stale label value in the bounded source file.', 'Run targeted, regression and Beta.7 QA gates.'],
        regressionRisk: ['A broader string replacement could change unrelated labels.'],
        confidence: 0.94,
        changes: [{ operation: 'replace', path: source.path, expectedSha256: source.sha256, content: "export const message = 'correct label';\n" }],
        targetedTests: [{ program: 'npm', args: ['run', failing ? 'test:fail' : 'test'] }],
        regression: { program: 'npm', args: ['run', 'build'] },
        beta7Qa: { program: 'npm', args: ['run', 'qa'] },
      };
    },
  };
}

describe('Beta.9 selected-finding planning', () => {
  it('creates mutation-blocked shared WorkItems only for explicit selections', () => {
    const qa = result([finding('one'), finding('two')]);
    const plan = buildBeta9Plan({ result: qa, selectedFingerprints: ['two'], project: 'demo' });
    expect(plan.selectedFindings).toHaveLength(1);
    expect(plan.selectedFindings[0]!.finding.fingerprint).toBe('two');
    expect(plan.workPlan.items[0]).toMatchObject({ kind: 'bug-fix', status: 'planned', approval: { approved: false }, execution: { mutationAllowed: false, maxAttempts: 3, requireBeta7Qa: true } });
    expect(plan.retryAuthorizations).toEqual({});
    expect(validateBeta9Plan(plan).valid).toBe(true);
    expect(() => buildBeta9Plan({ result: qa, selectedFingerprints: ['missing'] })).toThrow(/not present/);
    expect(() => buildBeta9Plan({ result: qa, selectedFingerprints: ['one', 'one'] })).toThrow(/duplicate/);
  });

  it('produces a concrete reviewable fix plan before approval and binds affected files into the WorkItem', async () => {
    const root = await fixtureRepo();
    const beta9 = buildBeta9Plan({ result: result(), selectedFingerprints: ['finding-123'], project: 'demo' });
    const item = beta9.workPlan.items[0]!;
    const planner = new Beta9FixPlanner(model(), new LocalGitFixWorkspace(root));
    const planned = await planner.plan(beta9, item.id);
    expect(planned.planned).toBe(true);
    expect(planned.plan).toMatchObject({ workItemId: item.id, findingFingerprint: 'finding-123', confidence: 0.94 });
    expect(planned.plan?.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(item.affectedFiles).toContain('src/app.ts');
    expect(item.approval.approved).toBe(false);
    expect(item.execution.mutationAllowed).toBe(false);
  });

  it('requires post-QA correlation before completion and blocks attempt 2 without retry authorization', async () => {
    const root = await fixtureRepo();
    const before = result();
    const beta9 = buildBeta9Plan({ result: before, selectedFingerprints: ['finding-123'], project: 'demo' });
    const item = beta9.workPlan.items[0]!;
    const planner = new Beta9FixPlanner(model(), new LocalGitFixWorkspace(root));
    const planned = await planner.plan(beta9, item.id);
    expect(planned.planned).toBe(true);
    approveWorkItem(beta9.workPlan, item.id, { approvedBy: 'owner', allowedPaths: ['src/app.ts'] });
    const executor = new Beta9FixExecutor(new LocalGitBackendWorkspace(root, 'aiqa/fix'));

    const retryWithoutCorrelation = await executor.execute(beta9, item.id, planned.plan!, { confirmPlanHash: planned.plan!.planHash, attempt: 2 });
    expect(retryWithoutCorrelation.verified).toBe(false);
    expect(retryWithoutCorrelation.error).toMatch(/post-QA retry authorization/);

    const rejected = await executor.execute(beta9, item.id, planned.plan!, { confirmPlanHash: '0'.repeat(64), attempt: 1 });
    expect(rejected.verified).toBe(false);
    expect(rejected.executed).toBe(false);

    const executed = await executor.execute(beta9, item.id, planned.plan!, { confirmPlanHash: planned.plan!.planHash, attempt: 1 });
    expect(executed).toMatchObject({ executed: true, targetedPassed: true, regressionPassed: true, beta7Passed: true, verified: true, rolledBack: false });
    expect(item.status).toBe('verification');
    expect(executed.attemptRecord.outcome).toBe('awaiting-correlation');
    expect(await readFile(path.join(root, 'src/app.ts'), 'utf8')).toContain('correct label');
    expect((await exec('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toMatch(/^aiqa\/fix\/b9-fix-/);

    const correlation = correlateBeta9Attempt({ beta9, itemId: item.id, before, after: result([], 'run-beta7-post'), attempt: executed.attemptRecord });
    expect(correlation).toMatchObject({ status: 'resolved', retryEligible: false, newCriticalHigh: [] });
    applyBeta9Correlation(beta9, correlation);
    expect(item.status).toBe('completed');
  });

  it('correlates persistent findings conservatively and creates one bounded retry authorization', () => {
    const before = result();
    const beta9 = buildBeta9Plan({ result: before, selectedFingerprints: ['finding-123'], project: 'demo' });
    const item = beta9.workPlan.items[0]!;
    item.status = 'verification';
    const attempt = {
      schemaVersion: 1 as const,
      workItemId: item.id,
      findingFingerprint: 'finding-123',
      fixPlanHash: 'a'.repeat(64),
      attempt: 1,
      outcome: 'awaiting-correlation' as const,
      originalBranch: 'feature/product-work',
      executionBranch: `aiqa/fix/${item.id.toLowerCase()}`,
    };
    const after = result([finding('finding-123')], 'run-beta7-post-persistent');
    const correlation = correlateBeta9Attempt({ beta9, itemId: item.id, before, after, attempt });
    expect(correlation.status).toBe('persistent');
    expect(correlation.retryEligible).toBe(true);
    applyBeta9Correlation(beta9, correlation);
    expect(item.status).toBe('blocked');
    const authorization = prepareBeta9Retry(beta9, correlation);
    expect(authorization).toMatchObject({ previousAttempt: 1, nextAttempt: 2, workItemId: item.id });
    expect(authorization.authorizationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(item).toMatchObject({ status: 'planned', approval: { approved: false }, execution: { mutationAllowed: false, allowedPaths: [] } });
    expect(beta9.retryAuthorizations?.[item.id]?.authorizationHash).toBe(authorization.authorizationHash);
    expect(validateBeta9Plan(beta9).valid).toBe(true);
  });

  it('blocks automatic retry when a new critical/high regression appears', () => {
    const before = result();
    const beta9 = buildBeta9Plan({ result: before, selectedFingerprints: ['finding-123'], project: 'demo' });
    const item = beta9.workPlan.items[0]!;
    const newRegression: Finding = { ...finding('regression-999'), id: 'F-999', title: 'New critical regression', severity: 'critical', url: 'http://127.0.0.1/settings' };
    const correlation = correlateBeta9Attempt({
      beta9,
      itemId: item.id,
      before,
      after: result([finding('finding-123'), newRegression], 'run-beta7-regressed'),
      attempt: { schemaVersion: 1, workItemId: item.id, findingFingerprint: 'finding-123', fixPlanHash: 'b'.repeat(64), attempt: 1, outcome: 'rolled-back' },
    });
    expect(correlation.status).toBe('persistent');
    expect(correlation.newCriticalHigh).toHaveLength(1);
    expect(correlation.retryEligible).toBe(false);
    expect(() => prepareBeta9Retry(beta9, correlation)).toThrow(/does not authorize/);
  });

  it('rolls back a failed fix attempt and marks the selected item blocked', async () => {
    const root = await fixtureRepo();
    const beta9 = buildBeta9Plan({ result: result(), selectedFingerprints: ['finding-123'], project: 'demo' });
    const item = beta9.workPlan.items[0]!;
    const planner = new Beta9FixPlanner(model(true), new LocalGitFixWorkspace(root));
    const planned = await planner.plan(beta9, item.id);
    expect(planned.planned).toBe(true);
    approveWorkItem(beta9.workPlan, item.id, { approvedBy: 'owner', allowedPaths: ['src/app.ts'] });
    const executor = new Beta9FixExecutor(new LocalGitBackendWorkspace(root, 'aiqa/fix'));
    const executed = await executor.execute(beta9, item.id, planned.plan!, { confirmPlanHash: planned.plan!.planHash, attempt: 1 });
    expect(executed).toMatchObject({ executed: true, verified: false, rolledBack: true });
    expect(executed.attemptRecord.outcome).toBe('rolled-back');
    expect(item.status).toBe('blocked');
    expect(await readFile(path.join(root, 'src/app.ts'), 'utf8')).toContain('wrong label');
    expect((await exec('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toBe('feature/product-work');
  });
});
