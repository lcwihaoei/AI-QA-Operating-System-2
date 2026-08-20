import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { finalizeMockMigrationProposal } from '../src/backend/mock-migration-executor.js';
import { LocalGitMockMigrationAcceptance, type MockMigrationExecutionEvidence } from '../src/backend/mock-migration-acceptance.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }

async function repoFixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'aiqa-mock-accept-'));
  roots.push(repo);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'mock.json'), '[{"id":1}]\n');
  await exec('git', ['init'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'QA Test'], { cwd: repo });
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: repo });
  await exec('git', ['switch', '-c', 'feature/product'], { cwd: repo });
  await exec('git', ['switch', '-c', 'aiqa/mock/mock-abc'], { cwd: repo });
  return repo;
}

function execution(proposalHash: string): MockMigrationExecutionEvidence {
  return {
    schemaVersion: 1,
    recordId: 'MOCK-ABC',
    proposalHash,
    executedAt: new Date().toISOString(),
    branch: 'aiqa/mock/mock-abc',
    executed: true,
    targetedPassed: true,
    regressionPassed: true,
    beta7Passed: true,
    verified: true,
    rolledBack: false,
    evidence: ['targeted:npm test', 'beta7:npm run qa'],
  };
}

describe('LocalGitMockMigrationAcceptance', () => {
  it('hashes exact verified created files and creates only a local acceptance commit', async () => {
    const repo = await repoFixture();
    await mkdir(path.join(repo, 'backend', 'seeds'), { recursive: true });
    await writeFile(path.join(repo, 'backend', 'seeds', 'demo.json'), '[{"id":1}]\n');
    const proposal = finalizeMockMigrationProposal({
      schemaVersion: 1, recordId: 'MOCK-ABC', decisionHash: 'a'.repeat(64), summary: 'seed',
      changes: [{ operation: 'create', path: 'backend/seeds/demo.json', content: '[{"id":1}]\n' }],
      targetedTests: [{ program: 'npm', args: ['test'] }], regression: { program: 'npm', args: ['run', 'build'] }, beta7Qa: { program: 'npm', args: ['run', 'qa'] },
    });
    const acceptance = new LocalGitMockMigrationAcceptance(repo);
    const preview = await acceptance.preview('MOCK-ABC', proposal, execution(proposal.proposalHash));
    expect(preview.changedFiles).toEqual([{ operation: 'create', path: 'backend/seeds/demo.json', sha256: sha('[{"id":1}]\n') }]);
    await expect(acceptance.accept({ recordId: 'MOCK-ABC', proposal, execution: execution(proposal.proposalHash), confirmAcceptanceHash: '0'.repeat(64), acceptedBy: 'owner' })).rejects.toThrow(/exact verified tree hash/i);
    const record = await acceptance.accept({ recordId: 'MOCK-ABC', proposal, execution: execution(proposal.proposalHash), confirmAcceptanceHash: preview.acceptanceHash, acceptedBy: 'owner' });
    expect(record.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');
    expect((await exec('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()).toBe('aiqa/mock/mock-abc');
  });

  it('accepts an exact verified deletion using the reviewed pre-change sha', async () => {
    const repo = await repoFixture();
    const content = await readFile(path.join(repo, 'src', 'mock.json'), 'utf8');
    await unlink(path.join(repo, 'src', 'mock.json'));
    const proposal = finalizeMockMigrationProposal({
      schemaVersion: 1, recordId: 'MOCK-ABC', decisionHash: 'a'.repeat(64), summary: 'remove mock',
      changes: [{ operation: 'delete', path: 'src/mock.json', expectedSha256: sha(content) }],
      targetedTests: [{ program: 'npm', args: ['test'] }], regression: { program: 'npm', args: ['run', 'build'] }, beta7Qa: { program: 'npm', args: ['run', 'qa'] },
    });
    const acceptance = new LocalGitMockMigrationAcceptance(repo);
    const preview = await acceptance.preview('MOCK-ABC', proposal, execution(proposal.proposalHash));
    expect(preview.changedFiles[0]).toEqual({ operation: 'delete', path: 'src/mock.json', sha256: sha(content) });
    const record = await acceptance.accept({ recordId: 'MOCK-ABC', proposal, execution: execution(proposal.proposalHash), confirmAcceptanceHash: preview.acceptanceHash, acceptedBy: 'owner' });
    expect(record.commitSha).toMatch(/^[a-f0-9]{40}$/);
    await expect(readFile(path.join(repo, 'src', 'mock.json'), 'utf8')).rejects.toThrow();
    expect((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');
  });
});
