import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding, QaRunResult } from '../src/core/types.js';
import { Beta9DashboardActionService } from '../src/control/beta9-action-service.js';
import { buildBeta9Plan } from '../src/fix/beta9-planner.js';

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function selectedFinding(): Finding {
  return {
    id: 'F-001',
    kind: 'ui',
    severity: 'high',
    title: 'Broken message card',
    url: 'http://127.0.0.1/messages',
    message: 'The message card renders the wrong label after refresh.',
    reproduction: ['Open /messages', 'Refresh', 'Observe wrong label'],
    evidence: ['screenshots/f-001.png'],
    fingerprint: 'finding-dashboard-123',
  };
}

function qaResult(runId: string, findings: Finding[]): QaRunResult {
  return { runId, findings } as unknown as QaRunResult;
}

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta9-dashboard-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'beta9-dashboard-fixture',
    private: true,
    scripts: {
      test: 'node -e "process.exit(0)"',
      build: 'node -e "process.exit(0)"',
      qa: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  await writeFile(path.join(root, 'src/app.ts'), "export const message = 'wrong label';\n");
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'QA Test'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
  await exec('git', ['switch', '-c', 'feature/product-work'], { cwd: root });
  return root;
}

async function modelServer(): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      context: { workItem: { id: string }; finding: { fingerprint: string }; files: Array<{ path: string; sha256: string; content: string }> };
    };
    const source = payload.context.files.find((file) => file.path === 'src/app.ts') ?? payload.context.files[0]!;
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      schemaVersion: 1,
      workItemId: payload.context.workItem.id,
      findingFingerprint: payload.context.finding.fingerprint,
      summary: 'Correct the stale label in the bounded source file.',
      rootCause: 'The UI reads a stale source constant.',
      recommendedChange: ['Replace only the stale constant.', 'Run targeted, regression and Beta.7 verification.'],
      regressionRisk: ['Do not replace unrelated labels.'],
      confidence: 0.96,
      changes: [{ operation: 'replace', path: source.path, expectedSha256: source.sha256, content: "export const message = 'correct label';\n" }],
      targetedTests: [{ program: 'npm', args: ['run', 'test'] }],
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

describe('Beta.9 governed dashboard action service', () => {
  it('requires review/approval, executes an exact bounded plan, then completes only after fresh Beta.7 correlation', async () => {
    const root = await fixtureRepo();
    const endpoint = await modelServer();
    const artifactRoot = path.join(root, '.qa-beta9');
    await mkdir(artifactRoot, { recursive: true });
    const beforePath = path.join(root, 'before.json');
    const afterPath = path.join(root, 'after.json');
    const planPath = path.join(artifactRoot, 'plan.json');
    const finding = selectedFinding();
    const before = qaResult('run-before', [finding]);
    const after = qaResult('run-after', []);
    await writeFile(beforePath, JSON.stringify(before));
    await writeFile(afterPath, JSON.stringify(after));
    const plan = buildBeta9Plan({ result: before, selectedFingerprints: [finding.fingerprint], project: 'dashboard fixture' });
    await writeFile(planPath, JSON.stringify(plan));
    const itemId = plan.workPlan.items[0]!.id;

    const service = new Beta9DashboardActionService({
      planPath,
      sourceResultPath: beforePath,
      postResultPath: afterPath,
      repoPath: root,
      modelEndpoint: endpoint,
      artifactRoot,
    });

    const planned = await service.generateFixPlan(itemId);
    const planSummary = planned.items[itemId]!.plan!;
    expect(planSummary.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(planSummary.changes).toEqual([{ operation: 'replace', path: 'src/app.ts' }]);
    expect(JSON.stringify(planned)).not.toContain("export const message = 'correct label'");
    expect((JSON.parse(await readFile(planPath, 'utf8')) as { workPlan: { items: Array<{ approval: { approved: boolean }; execution: { mutationAllowed: boolean } }> } }).workPlan.items[0]).toMatchObject({ approval: { approved: false }, execution: { mutationAllowed: false } });

    const approved = await service.approveFix(itemId, planSummary.planHash, 'owner');
    expect(approved.items[itemId]!.phase).toBe('approved');

    const executed = await service.executeFix(itemId, planSummary.planHash, true);
    expect(executed.items[itemId]!.phase).toBe('awaiting-correlation');
    expect(executed.items[itemId]!.attempt?.outcome).toBe('awaiting-correlation');
    expect(await readFile(path.join(root, 'src/app.ts'), 'utf8')).toContain('correct label');
    expect((await exec('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toMatch(/^aiqa\/fix\/b9-fix-/);

    const correlated = await service.correlate(itemId);
    expect(correlated.items[itemId]!.phase).toBe('completed');
    expect(correlated.items[itemId]!.correlation).toMatchObject({ status: 'resolved', retryEligible: false, postRunId: 'run-after' });
    const persisted = JSON.parse(await readFile(planPath, 'utf8')) as { workPlan: { items: Array<{ status: string }> } };
    expect(persisted.workPlan.items[0]!.status).toBe('completed');
  }, 20_000);

  it('does not expose source mutation actions when repository/model configuration is absent', async () => {
    const root = await fixtureRepo();
    const artifactRoot = path.join(root, '.qa-beta9');
    await mkdir(artifactRoot, { recursive: true });
    const beforePath = path.join(root, 'before.json');
    const planPath = path.join(artifactRoot, 'plan.json');
    const finding = selectedFinding();
    const before = qaResult('run-before', [finding]);
    await writeFile(beforePath, JSON.stringify(before));
    await writeFile(planPath, JSON.stringify(buildBeta9Plan({ result: before, selectedFingerprints: [finding.fingerprint] })));
    const service = new Beta9DashboardActionService({ planPath, sourceResultPath: beforePath, artifactRoot });
    const summary = await service.summary();
    expect(summary.configuration).toEqual({ repo: false, model: false, postResult: false });
    await expect(service.generateFixPlan(Object.keys(summary.items)[0]!)).rejects.toThrow(/repository is not configured/);
  });
});
