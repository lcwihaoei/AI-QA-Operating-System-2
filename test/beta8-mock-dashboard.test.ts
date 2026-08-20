import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMockMigrationPlan } from '../src/backend/mock-migration.js';
import { Beta8MockMigrationDashboardService } from '../src/control/beta8-mock-migration-service.js';

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta8-mock-dashboard-'));
  roots.push(repo);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({
    name: 'mock-dashboard-fixture', private: true,
    scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', qa: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(repo, 'src', 'mock-users.json'), JSON.stringify([{ id: 1, name: 'Demo' }], null, 2));
  await exec('git', ['init'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'QA Test'], { cwd: repo });
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: repo });
  await exec('git', ['switch', '-c', 'feature/product'], { cwd: repo });
  const artifacts = path.join(repo, '.qa-backend');
  await mkdir(artifacts, { recursive: true });
  const plan = buildMockMigrationPlan({
    project: 'demo',
    items: [{ source: 'src/mock-users.json', kind: 'mock-file', proposedAction: 'review-for-seed', destructive: false, requiresUserApproval: true }],
  });
  await writeFile(path.join(artifacts, 'mock-migration-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return { repo, artifacts, recordId: plan.records[0]!.id };
}

async function modelEndpoint(): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { context: { record: { id: string; approval: { decisionHash: string } }; source: { sha256: string } } };
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      schemaVersion: 1,
      recordId: body.context.record.id,
      decisionHash: body.context.record.approval.decisionHash,
      summary: 'Create reviewed demo seed data without deleting the source mock.',
      changes: [{ operation: 'create', path: 'backend/seeds/users.json', content: '[{"id":1,"name":"Demo"}]\n' }],
      targetedTests: [{ program: 'npm', args: ['test'] }],
      regression: { program: 'npm', args: ['run', 'build'] },
      beta7Qa: { program: 'npm', args: ['run', 'qa'] },
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model endpoint unavailable');
  return `http://127.0.0.1:${address.port}`;
}

describe('Beta.8 mock migration dashboard service', () => {
  it('requires per-source approval and live verification before a bounded seed migration', async () => {
    const { repo, artifacts, recordId } = await fixture();
    const endpoint = await modelEndpoint();
    const service = new Beta8MockMigrationDashboardService({ repoPath: repo, artifactRoot: artifacts, modelEndpoint: endpoint });

    const initial = await service.summary();
    expect(initial.available).toBe(true);
    expect(initial.records[0]).toMatchObject({ id: recordId, status: 'pending', approved: false });

    const approved = await service.approve({
      recordId,
      approvedBy: 'owner',
      action: 'convert-to-seed',
      seedDestination: 'backend/seeds/users.json',
      removeSourceAfterSeed: false,
    });
    expect(approved.records[0]).toMatchObject({ status: 'approved', approved: true, selectedAction: 'convert-to-seed' });
    await expect(service.propose(recordId)).rejects.toThrow(/live backend verification/i);

    const live = await service.verifyLive(recordId, { program: 'npm', args: ['test'] });
    expect(live.records[0]?.status).toBe('live-verified');

    const proposed = await service.propose(recordId);
    const proposal = proposed.records[0]?.action?.latestProposal?.summary;
    expect(proposal?.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal?.changes).toEqual([{ operation: 'create', path: 'backend/seeds/users.json' }]);
    expect(JSON.stringify(proposed)).not.toContain('[{"id":1,"name":"Demo"}]');

    const executed = await service.execute(recordId, proposal!.proposalHash, true);
    expect(executed.records[0]?.status).toBe('completed');
    expect(executed.records[0]?.action?.latestExecution).toMatchObject({ verified: true, rolledBack: false });
    expect(await readFile(path.join(repo, 'backend', 'seeds', 'users.json'), 'utf8')).toContain('Demo');
    expect(await readFile(path.join(repo, 'src', 'mock-users.json'), 'utf8')).toContain('Demo');
    expect((await exec('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()).toMatch(/^aiqa\/mock\//);
  }, 30_000);

  it('can explicitly retain a mock without repository mutation', async () => {
    const { repo, artifacts, recordId } = await fixture();
    const before = await readFile(path.join(repo, 'src', 'mock-users.json'), 'utf8');
    const service = new Beta8MockMigrationDashboardService({ repoPath: repo, artifactRoot: artifacts });
    await service.approve({ recordId, approvedBy: 'owner', action: 'retain' });
    const completed = await service.completeNoMutation(recordId);
    expect(completed.records[0]).toMatchObject({ status: 'completed', selectedAction: 'retain' });
    expect(await readFile(path.join(repo, 'src', 'mock-users.json'), 'utf8')).toBe(before);
    expect((await exec('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()).toBe('feature/product');
  });
});
