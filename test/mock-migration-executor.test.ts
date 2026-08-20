import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalGitMockMigrationWorkspace } from '../src/backend/local-git-mock-migration-workspace.js';
import { MockMigrationExecutor, type MockMigrationModel } from '../src/backend/mock-migration-executor.js';
import { approveMockMigrationRecord, buildMockMigrationPlan } from '../src/backend/mock-migration.js';
import type { MockMigrationItem } from '../src/backend/security-blueprint.js';

const exec = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true }); });

function migrationItem(): MockMigrationItem {
  return { source: 'src/mocks/users.json', kind: 'local-json', proposedAction: 'review-for-seed', destructive: false, requiresUserApproval: true };
}

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'aiqa-beta8-mock-'));
  cleanup.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'mock-migration-fixture', private: true,
    scripts: {
      test: 'node -e "process.exit(0)"',
      build: 'node -e "process.exit(0)"',
      qa: 'node -e "process.exit(0)"',
      'test:fail': 'node -e "process.exit(1)"',
    },
  }, null, 2));
  await exec('mkdir', ['-p', 'src/mocks'], { cwd: root });
  await writeFile(path.join(root, 'src/mocks/users.json'), '[{"id":1,"name":"Demo"}]\n');
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'QA Test'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
  await exec('git', ['switch', '-c', 'feature/live-backend'], { cwd: root });
  return root;
}

function approvedPlan() {
  const plan = buildMockMigrationPlan({ project: 'demo', items: [migrationItem()] });
  const record = plan.records[0]!;
  approveMockMigrationRecord(plan, record.id, {
    approvedBy: 'owner', action: 'convert-to-seed', seedDestination: 'backend/seeds/users.json', removeSourceAfterSeed: true,
  });
  return plan;
}

function model(failing = false): MockMigrationModel {
  return {
    async propose(context) {
      return {
        schemaVersion: 1,
        recordId: context.record.id,
        decisionHash: context.record.approval.decisionHash!,
        summary: 'Move reviewed demo users into the approved backend seed and remove the obsolete mock source.',
        changes: [
          { operation: 'create', path: context.record.seedDestination!, content: context.source.content },
          { operation: 'delete', path: context.record.source, expectedSha256: context.source.sha256 },
        ],
        targetedTests: [{ program: 'npm', args: ['run', failing ? 'test:fail' : 'test'] }],
        regression: { program: 'npm', args: ['run', 'build'] },
        beta7Qa: { program: 'npm', args: ['run', 'qa'] },
      };
    },
  };
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch { return false; }
}

describe('Beta.8 mock migration executor', () => {
  it('requires live-backend verification before producing a destructive migration proposal', async () => {
    const root = await fixtureRepo();
    const plan = approvedPlan();
    const executor = new MockMigrationExecutor(model(), new LocalGitMockMigrationWorkspace(root));
    const record = plan.records[0]!;
    const before = await executor.propose(plan, record.id);
    expect(before.planned).toBe(false);
    expect(before.error).toMatch(/live backend verification/);
    const live = await executor.verifyLive(plan, record.id, { program: 'npm', args: ['test'] });
    expect(live.verified).toBe(true);
    expect(record.status).toBe('live-verified');
    expect(record.liveVerificationEvidence[0]).toContain('npm test');
  });

  it('moves approved mock data to seed data only after exact proposal-hash confirmation and Beta.7 QA', async () => {
    const root = await fixtureRepo();
    const plan = approvedPlan();
    const workspace = new LocalGitMockMigrationWorkspace(root);
    const executor = new MockMigrationExecutor(model(), workspace);
    const record = plan.records[0]!;
    expect((await executor.verifyLive(plan, record.id, { program: 'npm', args: ['test'] })).verified).toBe(true);
    const planned = await executor.propose(plan, record.id);
    expect(planned.planned).toBe(true);
    expect(planned.proposal?.proposalHash).toMatch(/^[a-f0-9]{64}$/);

    const wrong = await executor.execute(plan, record.id, planned.proposal!, { confirmProposalHash: '0'.repeat(64) });
    expect(wrong.verified).toBe(false);
    expect(wrong.error).toMatch(/exact mock migration proposal hash/);

    const result = await executor.execute(plan, record.id, planned.proposal!, { confirmProposalHash: planned.proposal!.proposalHash });
    expect(result).toMatchObject({ executed: true, targetedPassed: true, regressionPassed: true, beta7Passed: true, verified: true, rolledBack: false });
    expect(record.status).toBe('completed');
    expect(record.completionEvidence.some((value) => value.startsWith('beta7:'))).toBe(true);
    expect(await exists(path.join(root, 'src/mocks/users.json'))).toBe(false);
    expect(await readFile(path.join(root, 'backend/seeds/users.json'), 'utf8')).toContain('Demo');
    expect((await exec('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toMatch(/^aiqa\/mock\/mock-/);
  });

  it('rolls back both created seed data and deleted mock source when targeted verification fails', async () => {
    const root = await fixtureRepo();
    const plan = approvedPlan();
    const executor = new MockMigrationExecutor(model(true), new LocalGitMockMigrationWorkspace(root));
    const record = plan.records[0]!;
    expect((await executor.verifyLive(plan, record.id, { program: 'npm', args: ['test'] })).verified).toBe(true);
    const planned = await executor.propose(plan, record.id);
    expect(planned.planned).toBe(true);
    const result = await executor.execute(plan, record.id, planned.proposal!, { confirmProposalHash: planned.proposal!.proposalHash });
    expect(result).toMatchObject({ executed: true, verified: false, rolledBack: true });
    expect(record.status).toBe('blocked');
    expect(await exists(path.join(root, 'src/mocks/users.json'))).toBe(true);
    expect(await exists(path.join(root, 'backend/seeds/users.json'))).toBe(false);
    expect((await exec('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toBe('feature/live-backend');
  });
});
