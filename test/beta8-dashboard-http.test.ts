import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta8-http-'));
  roots.push(root);
  const repo = path.join(root, 'frontend');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({
    name: 'dashboard-fixture', private: true, dependencies: { vue: '^3.0.0' },
    scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', qa: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(repo, 'src', 'main.ts'), `export const users=[{id:1}]; export async function load(){return fetch('/api/users').then(r=>r.json())}`);
  await exec('git', ['init'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'QA Test'], { cwd: repo });
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: repo });
  await exec('git', ['switch', '-c', 'feature/product'], { cwd: repo });
  return { root, repo, artifacts: path.join(repo, '.qa-backend') };
}

async function modelEndpoint(): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { context: { workItem: { id: string; approval: { scopeHash: string } } } };
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      schemaVersion: 1,
      workItemId: body.context.workItem.id,
      scopeHash: body.context.workItem.approval.scopeHash,
      summary: 'Create approved backend foundation.',
      changes: [{ operation: 'create', path: 'backend/http.ts', content: 'export const httpReady = true;\n' }],
      targetedTests: [{ program: 'npm', args: ['test'] }],
      regression: { program: 'npm', args: ['run', 'build'] },
      beta7Qa: { program: 'npm', args: ['run', 'qa'] },
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

async function request(base: string, method: string, endpoint: string, body?: unknown) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() as any };
}

function answer(question: any): string | string[] | boolean {
  if (question.kind === 'boolean') return true;
  if (question.kind === 'multi') return [question.options[0]];
  if (question.kind === 'single') return question.options[0];
  return question.id === 'deployment-target' ? 'Container on VM' : 'Confirmed';
}

describe('Beta.8 dashboard HTTP workflow', () => {
  it('drives discovery → interview → blueprint → scope approval → proposal → exact execution through loopback endpoints', async () => {
    const { root, repo, artifacts } = await fixture();
    const model = await modelEndpoint();
    const sourceBefore = await readFile(path.join(repo, 'src', 'main.ts'), 'utf8');
    const started = await startDashboard(new ControlPlaneStore(path.join(root, '.qa-control', 'state.json')), {
      host: '127.0.0.1', port: 0, allowActions: true,
      beta8RepoPath: repo, beta8ArtifactRoot: artifacts, beta8ModelEndpoint: model,
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;

    const discovered = await request(base, 'POST', '/api/beta8/discover', {});
    expect(discovered.status).toBe(200);
    expect(discovered.json.phase).toBe('discovered');
    expect(discovered.json.discovery.filesScanned).toBeGreaterThan(0);

    for (const round of discovered.json.interview.rounds) {
      for (const question of round.questions) {
        if (!question.required && !question.requiresExplicitConfirmation) continue;
        const saved = await request(base, 'POST', '/api/beta8/answer', { questionId: question.id, value: answer(question), confirmed: true });
        expect(saved.status).toBe(200);
      }
    }

    const ready = await request(base, 'GET', '/api/beta8');
    expect(ready.json.phase).toBe('ready-for-blueprint');
    const blueprint = await request(base, 'POST', '/api/beta8/blueprint', {});
    expect(blueprint.status).toBe(200);
    expect(blueprint.json.phase).toBe('blueprint-ready');
    expect(blueprint.json.blueprint.workPlanValid).toBe(true);
    expect(await readFile(path.join(repo, 'src', 'main.ts'), 'utf8')).toBe(sourceBefore);

    const itemId = 'B8-FND-001';
    const approved = await request(base, 'POST', '/api/beta8/approve-task', { itemId, approvedBy: 'owner', allowedPaths: ['backend/**'] });
    expect(approved.status).toBe(200);
    expect(approved.json.blueprint.workItems.find((item: any) => item.id === itemId)).toMatchObject({ status: 'approved', approved: true });

    const proposed = await request(base, 'POST', '/api/beta8/propose-task', { itemId });
    expect(proposed.status).toBe(200);
    const proposal = proposed.json.blueprint.workItems.find((item: any) => item.id === itemId).action.latestProposal.summary;
    expect(proposal.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.changes).toEqual([{ operation: 'create', path: 'backend/http.ts' }]);
    expect(JSON.stringify(proposed.json)).not.toContain('httpReady = true');

    const wrong = await request(base, 'POST', '/api/beta8/execute-task', { itemId, proposalHash: '0'.repeat(64), confirmWrite: true });
    expect(wrong.status).toBe(400);
    expect(await readFile(path.join(repo, 'src', 'main.ts'), 'utf8')).toBe(sourceBefore);

    const executed = await request(base, 'POST', '/api/beta8/execute-task', { itemId, proposalHash: proposal.proposalHash, confirmWrite: true });
    expect(executed.status).toBe(200);
    expect(executed.json.blueprint.workItems.find((item: any) => item.id === itemId)).toMatchObject({ status: 'completed' });
    expect(await readFile(path.join(repo, 'backend', 'http.ts'), 'utf8')).toContain('httpReady = true');
    expect((await exec('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()).toBe('aiqa/backend/b8-fnd-001');

    const secondBlueprint = await request(base, 'POST', '/api/beta8/blueprint', {});
    expect(secondBlueprint.status).toBe(409);
  }, 35_000);

  it('rejects Beta.8 POST actions when --allow-actions is not enabled', async () => {
    const { root, repo, artifacts } = await fixture();
    const started = await startDashboard(new ControlPlaneStore(path.join(root, '.qa-control', 'state.json')), {
      host: '127.0.0.1', port: 0, beta8RepoPath: repo, beta8ArtifactRoot: artifacts,
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;
    const response = await request(base, 'POST', '/api/beta8/discover', {});
    expect(response.status).toBe(403);
    const summary = await request(base, 'GET', '/api/beta8');
    expect(summary.json.actionsAllowed).toBe(false);
  });
});
