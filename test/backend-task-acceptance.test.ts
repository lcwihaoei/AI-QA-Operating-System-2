import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendTaskExecutor } from '../src/backend/backend-executor.js';
import { LocalGitBackendWorkspace } from '../src/backend/local-git-backend-workspace.js';
import { LocalGitBackendTaskAcceptance } from '../src/backend/backend-task-acceptance.js';
import type { BackendImplementationModel } from '../src/backend/executor-types.js';
import { approveWorkItem, type WorkItem, type WorkPlan } from '../src/planning/work-item.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

function item(): WorkItem {
  return {
    id: 'B8-FND-001', kind: 'infrastructure', title: 'Backend foundation', goal: 'Create backend', why: 'Blueprint',
    source: [], status: 'planned', priority: 'P0', confidence: 1, dependencies: [], affectedModules: ['platform'], affectedFiles: [],
    designRequirements: [], implementationPlan: ['bootstrap'], securityImpact: ['deny by default'], risks: ['scope drift'],
    acceptanceCriteria: ['tests pass'], requiredTests: ['targeted'], qaStrategy: ['Beta.7'], approval: { required: true, approved: false },
    execution: { mutationAllowed: false, allowedPaths: [], forbiddenPaths: ['.git/**', '.github/workflows/**'], maxAttempts: 3, requireCleanWorkspace: true, requireIsolatedBranch: true, requireTargetedTests: true, requireRegressionTests: true, requireBeta7Qa: true },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta8-accept-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', qa: 'node -e "process.exit(0)"' } }));
  await writeFile(path.join(root, 'tracked.ts'), 'export const original = true;\n');
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'QA Test'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
  await exec('git', ['switch', '-c', 'feature/product'], { cwd: root });
  return root;
}

async function verifiedAttempt(root: string) {
  const plan: WorkPlan = { schemaVersion: 1, generatedAt: new Date().toISOString(), project: 'demo', purpose: 'backend', items: [item()] };
  approveWorkItem(plan, 'B8-FND-001', { approvedBy: 'owner', allowedPaths: ['backend/**'] });
  const model: BackendImplementationModel = {
    async propose(context) {
      return {
        schemaVersion: 1,
        workItemId: context.workItem.id,
        scopeHash: context.workItem.approval.scopeHash!,
        summary: 'Create verified backend file.',
        changes: [{ operation: 'create', path: 'backend/app.ts', content: 'export const ready = true;\n' }],
        targetedTests: [{ program: 'npm', args: ['test'] }],
        regression: { program: 'npm', args: ['run', 'build'] },
        beta7Qa: { program: 'npm', args: ['run', 'qa'] },
      };
    },
  };
  const executor = new BackendTaskExecutor(model, new LocalGitBackendWorkspace(root));
  const proposed = await executor.propose(plan, 'B8-FND-001');
  const result = await executor.execute(plan, 'B8-FND-001', proposed.proposal!, { confirmProposalHash: proposed.proposal!.proposalHash });
  expect(result.verified).toBe(true);
  return { proposal: proposed.proposal!, attempt: result.attemptRecord };
}

describe('Beta.8 verified task acceptance', () => {
  it('blocks extra user changes, requires exact tree hash, then creates a local-only acceptance commit', async () => {
    const root = await fixture();
    const { proposal, attempt } = await verifiedAttempt(root);
    const acceptance = new LocalGitBackendTaskAcceptance(root);

    await writeFile(path.join(root, 'unrelated.txt'), 'do not commit\n');
    await expect(acceptance.preview('B8-FND-001', proposal, attempt)).rejects.toThrow(/working-tree paths differ/i);
    await rm(path.join(root, 'unrelated.txt'));

    const preview = await acceptance.preview('B8-FND-001', proposal, attempt);
    expect(preview.acceptanceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.changedFiles).toHaveLength(1);
    expect(preview.changedFiles[0]).toMatchObject({ operation: 'create', path: 'backend/app.ts' });
    await expect(acceptance.accept({ itemId: 'B8-FND-001', proposal, attempt, confirmAcceptanceHash: '0'.repeat(64), acceptedBy: 'owner' })).rejects.toThrow(/exact verified tree hash/i);

    const record = await acceptance.accept({ itemId: 'B8-FND-001', proposal, attempt, confirmAcceptanceHash: preview.acceptanceHash, acceptedBy: 'owner' });
    expect(record.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect((await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()).toBe(record.commitSha);
    expect((await exec('git', ['status', '--porcelain'], { cwd: root })).stdout.trim()).toBe('');
    expect((await exec('git', ['log', '-1', '--pretty=%s'], { cwd: root })).stdout.trim()).toBe('aiqa(beta8): accept B8-FND-001');
    expect(await readFile(path.join(root, 'backend', 'app.ts'), 'utf8')).toContain('ready = true');
  }, 30_000);

  it('refuses acceptance from any branch other than the recorded isolated execution branch', async () => {
    const root = await fixture();
    const { proposal, attempt } = await verifiedAttempt(root);
    await exec('git', ['switch', 'feature/product'], { cwd: root });
    const acceptance = new LocalGitBackendTaskAcceptance(root);
    await expect(acceptance.preview('B8-FND-001', proposal, attempt)).rejects.toThrow(/current verified execution branch/i);
  });
});
