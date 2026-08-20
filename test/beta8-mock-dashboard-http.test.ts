import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMockMigrationPlan } from '../src/backend/mock-migration.js';
import { ControlPlaneStore } from '../src/control/control-plane.js';
import { startDashboard } from '../src/control/dashboard-server.js';

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta8-mock-http-'));
  roots.push(root);
  const repo = path.join(root, 'product');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({
    name: 'mock-http-fixture', private: true,
    scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', qa: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(repo, 'src', 'mock.json'), '[{"id":1}]\n');
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
    items: [{ source: 'src/mock.json', kind: 'mock-file', proposedAction: 'review-for-seed', destructive: false, requiresUserApproval: true }],
  });
  await writeFile(path.join(artifacts, 'mock-migration-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return { root, repo, artifacts, recordId: plan.records[0]!.id };
}

async function modelEndpoint(): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { context: { record: { id: string; approval: { decisionHash: string } } } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      schemaVersion: 1,
      recordId: body.context.record.id,
      decisionHash: body.context.record.approval.decisionHash,
      summary: 'Create bounded seed.',
      changes: [{ operation: 'create', path: 'backend/seeds/demo.json', content: '[{"id":1}]\n' }],
      targetedTests: [{ program: 'npm', args: ['test'] }],
      regression: { program: 'npm', args: ['run', 'build'] },
      beta7Qa: { program: 'npm', args: ['run', 'qa'] },
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model server unavailable');
  return `http://127.0.0.1:${address.port}`;
}

async function post(base: string, endpoint: string, body: unknown) {
  const response = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

describe('Beta.8 mock migration dashboard HTTP lifecycle', () => {
  it('drives decision → live verify → proposal → exact execution → verified local acceptance', async () => {
    const { root, repo, artifacts, recordId } = await fixture();
    const model = await modelEndpoint();
    const started = await startDashboard(new ControlPlaneStore(path.join(root, '.qa-control', 'state.json')), {
      host: '127.0.0.1', port: 0, allowActions: true,
      beta8RepoPath: repo, beta8ArtifactRoot: artifacts, beta8MockModelEndpoint: model,
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;

    const initial = await fetch(`${base}/api/beta8`).then((response) => response.json() as Promise<any>);
    expect(initial.mockMigration.records[0]).toMatchObject({ id: recordId, status: 'pending' });

    const approved = await post(base, '/api/beta8/mock-approve', {
      recordId, approvedBy: 'owner', action: 'convert-to-seed', seedDestination: 'backend/seeds/demo.json', removeSourceAfterSeed: false,
    });
    expect(approved.status).toBe(200);
    expect(approved.json.records[0].status).toBe('approved');

    const live = await post(base, '/api/beta8/mock-verify-live', { recordId, command: { program: 'npm', args: ['test'] } });
    expect(live.status).toBe(200);
    expect(live.json.records[0].status).toBe('live-verified');

    const proposed = await post(base, '/api/beta8/mock-propose', { recordId });
    expect(proposed.status).toBe(200);
    const hash = proposed.json.records[0].action.latestProposal.summary.proposalHash as string;
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    const wrong = await post(base, '/api/beta8/mock-execute', { recordId, proposalHash: '0'.repeat(64), confirmWrite: true });
    expect(wrong.status).toBe(409);
    expect(String(wrong.json.error)).toMatch(/latest reviewed proposal/i);

    const executed = await post(base, '/api/beta8/mock-execute', { recordId, proposalHash: hash, confirmWrite: true });
    expect(executed.status).toBe(200);
    expect(executed.json.records[0].status).toBe('completed');
    expect(await readFile(path.join(repo, 'backend', 'seeds', 'demo.json'), 'utf8')).toContain('id');

    const preview = await post(base, '/api/beta8/mock-preview-acceptance', { recordId });
    expect(preview.status).toBe(200);
    const acceptanceHash = preview.json.items[recordId].preview.acceptanceHash as string;
    expect(acceptanceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.json.items[recordId].preview.changedFiles).toEqual([
      expect.objectContaining({ operation: 'create', path: 'backend/seeds/demo.json', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);

    const wrongAcceptance = await post(base, '/api/beta8/mock-accept', { recordId, acceptanceHash: '0'.repeat(64), acceptedBy: 'owner' });
    expect(wrongAcceptance.status).toBe(409);

    const accepted = await post(base, '/api/beta8/mock-accept', { recordId, acceptanceHash, acceptedBy: 'owner' });
    expect(accepted.status).toBe(200);
    expect(accepted.json.items[recordId].record).toMatchObject({ acceptedBy: 'owner', acceptanceHash });
    expect(accepted.json.items[recordId].record.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout.split('\n').filter((line) => line && !line.includes('.qa-backend')).length).toBe(0);

    const js = await fetch(`${base}/beta8-mock-dashboard.js`);
    const css = await fetch(`${base}/beta8-mock-dashboard.css`);
    expect(js.status).toBe(200);
    const jsText = await js.text();
    expect(jsText).toContain('Mock Migration');
    expect(jsText).toContain('mock-preview-acceptance');
    expect(jsText).toContain('mock-accept');
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('#beta8MockWorkflow');
  }, 35_000);

  it('keeps mock migration POST actions disabled without --allow-actions', async () => {
    const { root, repo, artifacts, recordId } = await fixture();
    const started = await startDashboard(new ControlPlaneStore(path.join(root, '.qa-control', 'state.json')), {
      host: '127.0.0.1', port: 0, beta8RepoPath: repo, beta8ArtifactRoot: artifacts,
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;
    const response = await post(base, '/api/beta8/mock-approve', { recordId, approvedBy: 'owner', action: 'retain' });
    expect(response.status).toBe(403);
  });
});
