import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { BackendExecutionAttemptRecord, BackendTaskProposal } from './executor-types.js';

const CONTROL_ARTIFACT_ROOTS = ['.qa-beta9', '.qa-runs', '.qa-backend', '.qa-control', '.qa-fix'];
const MAX_OUTPUT = 50_000;

export interface Beta8AcceptancePreview {
  schemaVersion: 1;
  itemId: string;
  branch: string;
  parentSha: string;
  proposalHash: string;
  attempt: number;
  changedFiles: Array<{ operation: 'create' | 'replace'; path: string; sha256: string }>;
  acceptanceHash: string;
}

export interface Beta8AcceptanceRecord extends Beta8AcceptancePreview {
  acceptedAt: string;
  acceptedBy: string;
  commitSha: string;
}

interface CommandResult { exitCode: number; stdout: string; stderr: string }

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalize(value: string): string {
  return value.replace(/^\.\//, '').replace(/\\/g, '/');
}

function isControlArtifact(value: string): boolean {
  const normalized = normalize(value);
  return CONTROL_ARTIFACT_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function stablePreview(input: Omit<Beta8AcceptancePreview, 'acceptanceHash'>): Beta8AcceptancePreview {
  const canonical = {
    schemaVersion: 1 as const,
    itemId: input.itemId,
    branch: input.branch,
    parentSha: input.parentSha,
    proposalHash: input.proposalHash,
    attempt: input.attempt,
    changedFiles: [...input.changedFiles].sort((a, b) => a.path.localeCompare(b.path)),
  };
  return { ...canonical, acceptanceHash: sha256(JSON.stringify(canonical)) };
}

function parsePorcelainZero(value: string): Array<{ status: string; path: string }> {
  const entries = value.split('\0').filter(Boolean);
  const parsed: Array<{ status: string; path: string }> = [];
  for (const entry of entries) {
    if (entry.length < 4) throw new Error('unexpected git status entry during Beta.8 acceptance');
    const status = entry.slice(0, 2);
    const filePath = normalize(entry.slice(3));
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') throw new Error('renames/copies are not valid Beta.8 executor output');
    parsed.push({ status, path: filePath });
  }
  return parsed;
}

export class LocalGitBackendTaskAcceptance {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  async preview(itemId: string, proposal: BackendTaskProposal, attempt: BackendExecutionAttemptRecord): Promise<Beta8AcceptancePreview> {
    if (!itemId || proposal.workItemId !== itemId || attempt.workItemId !== itemId) throw new Error('Beta.8 acceptance item does not match proposal/attempt evidence');
    if (attempt.outcome !== 'verified' || !attempt.executionBranch || !attempt.originalBranch) throw new Error('Beta.8 acceptance requires a verified execution attempt with branch evidence');
    if (attempt.proposalHash !== proposal.proposalHash || attempt.scopeHash !== proposal.scopeHash) throw new Error('Beta.8 acceptance proposal/attempt hashes do not match');
    if (attempt.changedFiles.length === 0) throw new Error('Beta.8 acceptance has no verified source changes');

    const branch = (await this.exec('git', ['branch', '--show-current'])).stdout.trim();
    if (branch !== attempt.executionBranch || !branch.startsWith('aiqa/backend/')) throw new Error(`Beta.8 acceptance requires current verified execution branch ${attempt.executionBranch}`);
    const parentSha = (await this.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
    if (!/^[a-f0-9]{40}$/i.test(parentSha)) throw new Error('unable to determine Beta.8 acceptance parent commit');
    const cached = await this.exec('git', ['diff', '--cached', '--name-only']);
    if (cached.stdout.trim()) throw new Error('Beta.8 acceptance refuses a pre-staged index');

    const status = parsePorcelainZero((await this.exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout)
      .filter((entry) => !isControlArtifact(entry.path));
    const expected = [...attempt.changedFiles].sort((a, b) => a.path.localeCompare(b.path));
    const actualPaths = status.map((entry) => entry.path).sort((a, b) => a.localeCompare(b));
    const expectedPaths = expected.map((entry) => entry.path).sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error(`Beta.8 acceptance working-tree paths differ from verified attempt: expected ${expectedPaths.join(', ')}; found ${actualPaths.join(', ')}`);
    }

    const changedFiles: Beta8AcceptancePreview['changedFiles'] = [];
    for (const change of expected) {
      const entry = status.find((candidate) => candidate.path === change.path);
      if (!entry) throw new Error(`missing verified Beta.8 change during acceptance: ${change.path}`);
      if (change.operation === 'create' && entry.status !== '??') throw new Error(`created file has unexpected git status during acceptance: ${change.path}`);
      if (change.operation === 'replace' && entry.status !== ' M') throw new Error(`replaced file has unexpected git status during acceptance: ${change.path}`);
      const absolute = path.resolve(this.root, change.path);
      if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new Error('Beta.8 acceptance path escaped repository root');
      const bytes = await readFile(absolute);
      changedFiles.push({ ...change, sha256: sha256(bytes) });
    }

    return stablePreview({ schemaVersion: 1, itemId, branch, parentSha, proposalHash: proposal.proposalHash, attempt: attempt.attempt, changedFiles });
  }

  async accept(input: {
    itemId: string;
    proposal: BackendTaskProposal;
    attempt: BackendExecutionAttemptRecord;
    confirmAcceptanceHash: string;
    acceptedBy: string;
  }): Promise<Beta8AcceptanceRecord> {
    if (!input.acceptedBy.trim() || input.acceptedBy.length > 120) throw new Error('Beta.8 acceptance requires a bounded operator identity');
    const preview = await this.preview(input.itemId, input.proposal, input.attempt);
    if (!input.confirmAcceptanceHash || input.confirmAcceptanceHash !== preview.acceptanceHash) throw new Error('Beta.8 acceptance requires confirmation of the exact verified tree hash');
    const paths = preview.changedFiles.map((entry) => entry.path);
    await this.exec('git', ['add', '--', ...paths]);
    const staged = (await this.exec('git', ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean).map(normalize).sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(staged) !== JSON.stringify([...paths].sort((a, b) => a.localeCompare(b)))) {
      await this.exec('git', ['reset']);
      throw new Error('Beta.8 acceptance staged paths differ from verified attempt');
    }
    const tree = (await this.exec('git', ['write-tree'])).stdout.trim();
    if (!/^[a-f0-9]{40}$/i.test(tree)) throw new Error('unable to write verified Beta.8 acceptance tree');
    const message = `aiqa(beta8): accept ${input.itemId}`;
    const commitResult = await this.exec('git', [
      '-c', 'user.name=AI QA Operator',
      '-c', 'user.email=aiqa@localhost',
      'commit-tree', tree, '-p', preview.parentSha, '-m', message,
    ]);
    const commitSha = commitResult.stdout.trim();
    if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error('unable to create local Beta.8 acceptance commit');
    await this.exec('git', ['reset', '--hard', commitSha]);
    const current = (await this.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
    if (current !== commitSha) throw new Error('Beta.8 acceptance commit did not become the current branch head');
    const remaining = parsePorcelainZero((await this.exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout)
      .filter((entry) => !isControlArtifact(entry.path));
    if (remaining.length > 0) throw new Error('Beta.8 acceptance left unexpected non-control working-tree changes');
    return {
      ...preview,
      acceptedAt: new Date().toISOString(),
      acceptedBy: input.acceptedBy.trim(),
      commitSha,
    };
  }

  private exec(program: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd: this.root, shell: false, env: process.env });
      let stdout = '';
      let stderr = '';
      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        const value = chunk.toString('utf8');
        if (target === 'stdout') stdout = `${stdout}${value}`.slice(-MAX_OUTPUT);
        else stderr = `${stderr}${value}`.slice(-MAX_OUTPUT);
      };
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        const exitCode = code ?? 1;
        if (exitCode !== 0) reject(new Error(`${program} ${args[0] ?? ''} failed: ${stderr || stdout}`));
        else resolve({ exitCode, stdout, stderr });
      });
    });
  }
}
