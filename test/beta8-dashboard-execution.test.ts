import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { Beta8DashboardActionService } from '../src/control/beta8-action-service.js';

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function repoFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta8-dashboard-exec-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'beta8-dashboard-exec', private: true,
    scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', qa: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(root, 'src', 'app.ts'), `export async function users(){return fetch('/api/users').then(r=>r.json())}\n`);
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'QA Test'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
  await exec('git', ['switch', '-c', 'feature/product'], { cwd: root });
  return root;
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
      summary: 'Create the approved backend foundation only.',
      changes: [{ operation: 'create', path: 'backend/app.ts', content: 'export const ready = true;\n' }],
      targetedTests: [{ program: 'npm', args: ['test'] }],
      regression: { program: 'npm', args: ['run', 'build'] },
      beta7Qa: { program: 'npm', args: ['run', 'qa'] },
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model server address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

function answer(question: { kind: string; options?: string[]; id: string }): string | string[] | boolean {
  if (question.kind === 'boolean') return true;
  if (question.kind === 'multi') return [question.options?.[0] ?? 'None'];
  if (question.kind === 'single') return question.options?.[0] ?? 'Other';
  return question.id === 'deployment-target' ? 'Container on VM' : 'Confirmed';
}

async function prepareBlueprint(service: Beta8DashboardActionService) {
  const discovered = await service.discover();
  for (const round of discovered.interview!.rounds) {
    for (const question of round.questions) {
      if (!question.required && !question.requiresExplicitConfirmation) continue;
      await service.answer({ questionId: question.id, value: answer(question), confirmed: true });
    }
  }
  return service.generateBlueprint();
}

describe('Beta.8 dashboard bounded implementation', () => {
  it('requires scope approval, exposes only proposal metadata, confirms exact hash, then runs tests and Beta.7', async () => {
    const repo = await repoFixture();
    const endpoint = await modelEndpoint();
    const service = new Beta8DashboardActionService({ repoPath: repo, artifactRoot: path.join(repo, '.qa-backend'), modelEndpoint: endpoint });
    const blueprint = await prepareBlueprint(service);
    const itemId = blueprint.blueprint!.workItems.find((item) => item.id === 'B8-FND-001')!.id;

    const approved = await service.approveTask(itemId, 'owner', ['backend/**']);
    expect(approved.blueprint!.workItems.find((item) => item.id === itemId)).toMatchObject({ status: 'approved', approved: true, allowedPaths: ['backend/**'] });

    const proposed = await service.proposeTask(itemId);
    const item = proposed.blueprint!.workItems.find((candidate) => candidate.id === itemId)!;
    const proposal = item.action!.latestProposal!.summary;
    expect(proposal.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.changes).toEqual([{ operation: 'create', path: 'backend/app.ts' }]);
    expect(JSON.stringify(proposed)).not.toContain('export const ready = true');

    await expect(service.executeTask(itemId, '0'.repeat(64), true)).rejects.toThrow(/latest reviewed/i);
    const executed = await service.executeTask(itemId, proposal.proposalHash, true);
    expect(executed.blueprint!.workItems.find((candidate) => candidate.id === itemId)?.status).toBe('completed');
    expect(executed.blueprint!.workItems.find((candidate) => candidate.id === itemId)?.action?.latestAttempt?.outcome).toBe('verified');
    expect(await readFile(path.join(repo, 'backend', 'app.ts'), 'utf8')).toContain('ready = true');
    expect((await exec('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()).toBe('aiqa/backend/b8-fnd-001');
  }, 30_000);

  it('blocks dependent task approval until its predecessors are completed', async () => {
    const repo = await repoFixture();
    const service = new Beta8DashboardActionService({ repoPath: repo, artifactRoot: path.join(repo, '.qa-backend') });
    const blueprint = await prepareBlueprint(service);
    const dataTask = blueprint.blueprint!.workItems.find((item) => item.id === 'B8-DATA-001')!;
    await expect(service.approveTask(dataTask.id, 'owner', ['backend/**'])).rejects.toThrow(/dependencies/i);
  });
});
