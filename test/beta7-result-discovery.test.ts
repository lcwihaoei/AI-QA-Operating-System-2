import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverFreshBeta7Result } from '../src/control/beta7-result-discovery.js';

const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-post-result-'));
  roots.push(root);
  const artifactRoot = path.join(root, '.qa-beta9');
  const runsRoot = path.join(root, '.qa-runs');
  const sourceDir = path.join(runsRoot, 'source-run');
  const attemptDir = path.join(artifactRoot, 'attempts');
  await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(attemptDir, { recursive: true })]);
  const sourceResultPath = path.join(sourceDir, 'result.json');
  await writeFile(sourceResultPath, JSON.stringify({ runId: 'source-run', findings: [] }));
  const startedAt = new Date(Date.now() - 10_000).toISOString();
  const attemptPath = path.join(attemptDir, 'item-1-attempt-1.json');
  await writeFile(attemptPath, JSON.stringify({
    schemaVersion: 1,
    workItemId: 'ITEM-1',
    attempt: 1,
    startedAt,
    finishedAt: new Date(Date.now() - 5_000).toISOString(),
    outcome: 'awaiting-correlation',
  }));
  await writeFile(path.join(artifactRoot, 'dashboard-action-state.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    items: { 'ITEM-1': { latestAttempt: { file: attemptPath, attempt: 1, outcome: 'awaiting-correlation' } } },
  }));
  return { root, artifactRoot, runsRoot, sourceResultPath, startedAt };
}

async function writeRun(runsRoot: string, name: string, runId: string, when: Date): Promise<string> {
  const dir = path.join(runsRoot, name);
  await mkdir(dir, { recursive: true });
  const result = path.join(dir, 'result.json');
  await writeFile(result, JSON.stringify({ runId, findings: [] }));
  await utimes(result, when, when);
  return result;
}

describe('Beta.9 fresh Beta.7 result discovery', () => {
  it('selects exactly one valid result created after the recorded attempt started and ignores old/source runs', async () => {
    const f = await fixture();
    await writeRun(f.runsRoot, 'old-run', 'old-run', new Date(Date.parse(f.startedAt) - 30_000));
    const expected = await writeRun(f.runsRoot, 'fresh-run', 'fresh-run', new Date());
    const found = await discoverFreshBeta7Result({
      runsRoot: f.runsRoot,
      artifactRoot: f.artifactRoot,
      sourceResultPath: f.sourceResultPath,
      sourceRunId: 'source-run',
      itemId: 'ITEM-1',
    });
    expect(found).toMatchObject({ path: expected, runId: 'fresh-run', attempt: 1, attemptStartedAt: f.startedAt });
  });

  it('refuses ambiguity instead of guessing when more than one fresh run matches the attempt window', async () => {
    const f = await fixture();
    await writeRun(f.runsRoot, 'fresh-a', 'fresh-a', new Date());
    await writeRun(f.runsRoot, 'fresh-b', 'fresh-b', new Date());
    await expect(discoverFreshBeta7Result({
      runsRoot: f.runsRoot,
      artifactRoot: f.artifactRoot,
      sourceResultPath: f.sourceResultPath,
      sourceRunId: 'source-run',
      itemId: 'ITEM-1',
    })).rejects.toThrow(/multiple fresh Beta\.7 results/);
  });

  it('ignores invalid result JSON and symlinked run directories rather than trusting them as evidence', async () => {
    const f = await fixture();
    const invalidDir = path.join(f.runsRoot, 'invalid');
    await mkdir(invalidDir, { recursive: true });
    await writeFile(path.join(invalidDir, 'result.json'), '{not-json');
    const outside = path.join(f.root, 'outside-run');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'result.json'), JSON.stringify({ runId: 'symlink-run', findings: [] }));
    await symlink(outside, path.join(f.runsRoot, 'linked-run'), 'dir');
    await expect(discoverFreshBeta7Result({
      runsRoot: f.runsRoot,
      artifactRoot: f.artifactRoot,
      sourceResultPath: f.sourceResultPath,
      sourceRunId: 'source-run',
      itemId: 'ITEM-1',
    })).rejects.toThrow(/no fresh Beta\.7 result/);
  });

  it('rejects a tampered dashboard state that points the attempt record outside the artifact root', async () => {
    const f = await fixture();
    const outsideAttempt = path.join(f.root, 'outside-attempt.json');
    await writeFile(outsideAttempt, JSON.stringify({
      schemaVersion: 1,
      workItemId: 'ITEM-1',
      attempt: 1,
      startedAt: f.startedAt,
      finishedAt: new Date().toISOString(),
      outcome: 'awaiting-correlation',
    }));
    await writeFile(path.join(f.artifactRoot, 'dashboard-action-state.json'), JSON.stringify({
      schemaVersion: 1,
      items: { 'ITEM-1': { latestAttempt: { file: outsideAttempt, attempt: 1, outcome: 'awaiting-correlation' } } },
    }));
    await expect(discoverFreshBeta7Result({
      runsRoot: f.runsRoot,
      artifactRoot: f.artifactRoot,
      sourceResultPath: f.sourceResultPath,
      sourceRunId: 'source-run',
      itemId: 'ITEM-1',
    })).rejects.toThrow(/escaped the configured artifact root/);
  });
});
