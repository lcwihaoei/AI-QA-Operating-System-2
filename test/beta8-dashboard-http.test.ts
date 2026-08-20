import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlaneStore } from '../src/control/control-plane.js';
import { startDashboard } from '../src/control/dashboard-server.js';

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
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'dashboard-fixture', dependencies: { vue: '^3.0.0' } }));
  await writeFile(path.join(repo, 'src', 'main.ts'), `export const users=[{id:1}]; export async function load(){return fetch('/api/users').then(r=>r.json())}`);
  return { root, repo, artifacts: path.join(root, '.qa-backend') };
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
  it('keeps actions loopback/opt-in and drives discovery → interview → immutable blueprint without source mutation', async () => {
    const { root, repo, artifacts } = await fixture();
    const sourceBefore = await import('node:fs/promises').then(({ readFile }) => readFile(path.join(repo, 'src', 'main.ts'), 'utf8'));
    const started = await startDashboard(new ControlPlaneStore(path.join(root, '.qa-control', 'state.json')), {
      host: '127.0.0.1', port: 0, allowActions: true, beta8RepoPath: repo, beta8ArtifactRoot: artifacts,
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

    const sourceAfter = await import('node:fs/promises').then(({ readFile }) => readFile(path.join(repo, 'src', 'main.ts'), 'utf8'));
    expect(sourceAfter).toBe(sourceBefore);
    const second = await request(base, 'POST', '/api/beta8/blueprint', {});
    expect(second.status).toBe(409);
  }, 25_000);

  it('rejects Beta.8 POST actions when --allow-actions is not enabled', async () => {
    const { root, repo, artifacts } = await fixture();
    const started = await startDashboard(new ControlPlaneStore(path.join(root, '.qa-control', 'state.json')), {
      host: '127.0.0.1', port: 0, beta8RepoPath: repo, beta8ArtifactRoot: artifacts,
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;
    const response = await request(base, 'POST', '/api/beta8/discover', {});
    expect(response.status).toBe(403);
  });
});
