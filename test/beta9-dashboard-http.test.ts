import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlaneStore } from '../src/control/control-plane.js';
import { startDashboard } from '../src/control/dashboard-server.js';
import type { Finding, QaRunResult } from '../src/core/types.js';
import { buildBeta9Plan } from '../src/fix/beta9-planner.js';

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function finding(): Finding {
  return {
    id: 'F-HTTP-1', kind: 'ui', severity: 'high', title: 'HTTP loop label', url: 'http://127.0.0.1/messages',
    message: 'Label remains stale.', reproduction: ['Open messages'], evidence: ['screenshots/http.png'], fingerprint: 'beta9-http-fp',
  };
}

function result(runId: string, findings: Finding[]): QaRunResult {
  return { runId, findings } as unknown as QaRunResult;
}

async function repoFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta9-http-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', qa: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(root, 'src/app.ts'), "export const label = 'stale';\n");
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'QA Test'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
  await exec('git', ['switch', '-c', 'feature/product'], { cwd: root });
  return root;
}

async function fixModel(): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      context: { workItem: { id: string }; finding: { fingerprint: string }; files: Array<{ path: string; sha256: string }> };
    };
    const source = input.context.files.find((file) => file.path === 'src/app.ts') ?? input.context.files[0]!;
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      schemaVersion: 1,
      workItemId: input.context.workItem.id,
      findingFingerprint: input.context.finding.fingerprint,
      summary: 'Replace the stale label only.',
      rootCause: 'A stale constant is rendered.',
      recommendedChange: ['Replace the stale source constant.'],
      regressionRisk: ['Do not touch unrelated labels.'],
      confidence: 0.95,
      changes: [{ operation: 'replace', path: source.path, expectedSha256: source.sha256, content: "export const label = 'fresh';\n" }],
      targetedTests: [{ program: 'npm', args: ['run', 'test'] }],
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

async function post(base: string, endpoint: string, body: object): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

describe('Beta.9 governed dashboard HTTP workflow', () => {
  it('runs plan → exact approval → execute → fresh Beta.7 correlation through loopback endpoints', async () => {
    const root = await repoFixture();
    const modelEndpoint = await fixModel();
    const artifactRoot = path.join(root, '.qa-beta9');
    await mkdir(artifactRoot, { recursive: true });
    const sourceResultPath = path.join(artifactRoot, 'source-result.json');
    const postResultPath = path.join(artifactRoot, 'post-result.json');
    const planPath = path.join(artifactRoot, 'plan.json');
    const before = result('run-source', [finding()]);
    await writeFile(sourceResultPath, JSON.stringify(before));
    await writeFile(postResultPath, JSON.stringify(result('run-fresh', [])));
    const beta9 = buildBeta9Plan({ result: before, selectedFingerprints: ['beta9-http-fp'], project: 'HTTP dashboard' });
    await writeFile(planPath, JSON.stringify(beta9));
    const itemId = beta9.workPlan.items[0]!.id;

    const started = await startDashboard(new ControlPlaneStore(path.join(artifactRoot, 'control.json')), {
      host: '127.0.0.1', port: 0, allowActions: true,
      beta9PlanPath: planPath,
      beta7ResultPath: sourceResultPath,
      beta9RepoPath: root,
      beta9ModelEndpoint: modelEndpoint,
      beta9PostResultPath: postResultPath,
      beta9ArtifactRoot: artifactRoot,
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;

    const planned = await post(base, '/api/beta9/plan', { itemId });
    expect(planned.status).toBe(200);
    const planHash = planned.json.items[itemId].plan.planHash as string;
    expect(planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(planned.json)).not.toContain("export const label = 'fresh'");

    const approved = await post(base, '/api/beta9/approve', { itemId, planHash, approvedBy: 'owner' });
    expect(approved.status).toBe(200);
    expect(approved.json.items[itemId].phase).toBe('approved');

    const executed = await post(base, '/api/beta9/execute', { itemId, planHash, confirmWrite: true });
    expect(executed.status).toBe(200);
    expect(executed.json.items[itemId].phase).toBe('awaiting-correlation');
    expect(await readFile(path.join(root, 'src/app.ts'), 'utf8')).toContain('fresh');

    const correlated = await post(base, '/api/beta9/correlate', { itemId });
    expect(correlated.status).toBe(200);
    expect(correlated.json.items[itemId].phase).toBe('completed');
    expect(correlated.json.items[itemId].correlation).toMatchObject({ status: 'resolved', postRunId: 'run-fresh', retryEligible: false });
  }, 25_000);
});
