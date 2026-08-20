import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendTaskExecutor, validateBackendVerificationCommand } from '../src/backend/backend-executor.js';
import { LocalGitBackendWorkspace } from '../src/backend/local-git-backend-workspace.js';
import type { BackendImplementationModel } from '../src/backend/executor-types.js';
import { approveWorkItem, type WorkItem, type WorkPlan } from '../src/planning/work-item.js';

const exec = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true }); });

function workItem(): WorkItem {
  return {
    id: 'B8-FND-001', kind: 'infrastructure', title: 'Backend foundation', goal: 'Create backend foundation', why: 'Confirmed backend blueprint',
    source: [{ type: 'frontend-discovery', reference: 'blueprint:platform' }], status: 'planned', priority: 'P0', confidence: 1,
    dependencies: [], affectedModules: ['platform'], affectedFiles: [], designRequirements: [], implementationPlan: ['framework bootstrap'],
    securityImpact: ['deny by default'], risks: ['scope drift'], acceptanceCriteria: ['tests pass'], requiredTests: ['targeted', 'regression'], qaStrategy: ['Beta.7 after stage'],
    approval: { required: true, approved: false },
    execution: { mutationAllowed: false, allowedPaths: [], forbiddenPaths: ['.git/**', '.github/workflows/**', '**/.env*', '**/*secret*'], maxAttempts: 2, requireCleanWorkspace: true, requireIsolatedBranch: true, requireTargetedTests: true, requireRegressionTests: true, requireBeta7Qa: false },
  };
}

function approvedPlan(): WorkPlan {
  const plan: WorkPlan = { schemaVersion: 1, generatedAt: new Date().toISOString(), project: 'demo', purpose: 'backend', items: [workItem()] };
  approveWorkItem(plan, 'B8-FND-001', { approvedBy: 'owner', allowedPaths: ['backend/**'] });
  return plan;
}

describe('Beta.8 controlled backend executor', () => {
  it('restricts verification commands to test-like invocations', () => {
    expect(validateBackendVerificationCommand({ program: 'npm', args: ['test'] })).toBeUndefined();
    expect(validateBackendVerificationCommand({ program: 'npm', args: ['run', 'build'] })).toBeUndefined();
    expect(validateBackendVerificationCommand({ program: 'npm', args: ['run', 'deploy'] })).toMatch(/restricted/);
    expect(validateBackendVerificationCommand({ program: 'node', args: ['-e', 'process.exit(0)'] })).toMatch(/not allowed/);
    expect(validateBackendVerificationCommand({ program: 'python3', args: ['-c', 'print(1)'] })).toMatch(/restricted/);
  });

  it('executes only the exact reviewed proposal hash on an isolated git branch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiqa-beta8-exec-'));
    cleanup.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' } }, null, 2));
    await exec('git', ['init'], { cwd: root });
    await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: root });
    await exec('git', ['config', 'user.name', 'QA Test'], { cwd: root });
    await exec('git', ['add', 'package.json'], { cwd: root });
    await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
    await exec('git', ['switch', '-c', 'feature/integration'], { cwd: root });

    const plan = approvedPlan();
    const model: BackendImplementationModel = {
      async propose(context) {
        return {
          schemaVersion: 1,
          workItemId: context.workItem.id,
          scopeHash: context.workItem.approval.scopeHash!,
          summary: 'Create a minimal backend module.',
          changes: [{ operation: 'create', path: 'backend/app.ts', content: 'export const ready = true;\n' }],
          targetedTests: [{ program: 'npm', args: ['test'] }],
          regression: { program: 'npm', args: ['run', 'build'] },
        };
      },
    };
    const executor = new BackendTaskExecutor(model, new LocalGitBackendWorkspace(root));
    const planned = await executor.propose(plan, 'B8-FND-001');
    expect(planned.planned).toBe(true);
    expect(planned.proposal?.proposalHash).toMatch(/^[a-f0-9]{64}$/);

    const wrong = await executor.execute(plan, 'B8-FND-001', planned.proposal!, { confirmProposalHash: '0'.repeat(64) });
    expect(wrong.verified).toBe(false);
    expect(wrong.error).toMatch(/exact proposal hash/);

    const result = await executor.execute(plan, 'B8-FND-001', planned.proposal!, { confirmProposalHash: planned.proposal!.proposalHash });
    expect(result).toMatchObject({ executed: true, targetedPassed: true, regressionPassed: true, beta7Passed: true, verified: true, rolledBack: false });
    expect(plan.items[0]!.status).toBe('completed');
    expect((await exec('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toBe('aiqa/backend/b8-fnd-001');
    expect(await readFile(path.join(root, 'backend/app.ts'), 'utf8')).toContain('ready = true');
  });

  it('rejects model changes outside the human-approved path scope', async () => {
    const plan = approvedPlan();
    const workspace = {
      async currentBranch() { return 'feature/base'; }, async isClean() { return true; },
      async collectContext() { return [{ path: 'package.json', sha256: 'a'.repeat(64), content: '{}' }]; },
      async createBranch() { return 'aiqa/backend/b8-fnd-001'; }, async applyChange() {},
      async run() { return { exitCode: 0, stdout: '', stderr: '' }; }, async rollback() {},
    };
    const model: BackendImplementationModel = {
      async propose(context) {
        return {
          schemaVersion: 1, workItemId: context.workItem.id, scopeHash: context.workItem.approval.scopeHash!, summary: 'unsafe scope',
          changes: [{ operation: 'create', path: 'src/escape.ts', content: 'export {};\n' }],
          targetedTests: [{ program: 'npm', args: ['test'] }], regression: { program: 'npm', args: ['run', 'build'] },
        };
      },
    };
    const result = await new BackendTaskExecutor(model, workspace).propose(plan, 'B8-FND-001');
    expect(result.planned).toBe(false);
    expect(result.error).toMatch(/outside approved paths/);
  });
});
