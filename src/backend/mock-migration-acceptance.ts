import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { MockMigrationProposal } from './mock-migration-executor.js';

const CONTROL_ARTIFACT_ROOTS = ['.qa-beta9', '.qa-runs', '.qa-backend', '.qa-control', '.qa-fix'];
const MAX_OUTPUT = 50_000;

export interface MockMigrationExecutionEvidence {
  schemaVersion: 1;
  recordId: string;
  proposalHash: string;
  executedAt: string;
  branch?: string;
  executed: boolean;
  targetedPassed: boolean;
  regressionPassed: boolean;
  beta7Passed: boolean;
  verified: boolean;
  rolledBack: boolean;
  evidence: string[];
  error?: string;
}

export interface MockMigrationAcceptancePreview {
  schemaVersion: 1;
  recordId: string;
  branch: string;
  parentSha: string;
  proposalHash: string;
  changedFiles: Array<{ operation: 'create' | 'replace' | 'delete'; path: string; sha256: string }>;
  acceptanceHash: string;
}

export interface MockMigrationAcceptanceRecord extends MockMigrationAcceptancePreview {
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

function stablePreview(input: Omit<MockMigrationAcceptancePreview, 'acceptanceHash'>): MockMigrationAcceptancePreview {
  const canonical = {
    schemaVersion: 1 as const,
    recordId: input.recordId,
    branch: input.branch,
    parentSha: input.parentSha,
    proposalHash: input.proposalHash,
    changedFiles: [...input.changedFiles].sort((a, b) => a.path.localeCompare(b.path)),
  };
  return { ...canonical, acceptanceHash: sha256(JSON.stringify(canonical)) };
}

function parsePorcelainZero(value: string): Array<{ status: string; path: string }> {
  const entries = value.split('\0').filter(Boolean);
  const parsed: Array<{ status: string; path: string }> = [];
  for (const entry of entries) {
    if (entry.length < 4) throw new Error('unexpected git status entry during mock migration acceptance');
    const status = entry.slice(0, 2);
    const filePath = normalize(entry.slice(3));
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') throw new Error('renames/copies are not valid mock migration output');
    parsed.push({ status, path: filePath });
  }
  return parsed;
}

export class LocalGitMockMigrationAcceptance {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  async preview(recordId: string, proposal: MockMigrationProposal, execution: MockMigrationExecutionEvidence): Promise<MockMigrationAcceptancePreview> {
    if (!recordId || proposal.recordId !== recordId || execution.recordId !== recordId) throw new Error('mock acceptance record does not match proposal/execution evidence');
    if (!execution.verified || execution.rolledBack || !execution.branch) throw new Error('mock acceptance requires a verified non-rolled-back execution');
    if (execution.proposalHash !== proposal.proposalHash) throw new Error('mock acceptance proposal/execution hashes do not match');
    if (proposal.changes.length === 0) throw new Error('mock acceptance has no verified source changes');

    const branch = (await this.exec('git', ['branch', '--show-current'])).stdout.trim();
    if (branch !== execution.branch || !branch.startsWith('aiqa/mock/')) throw new Error(`mock acceptance requires current verified execution branch ${execution.branch}`);
    const parentSha = (await this.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
    if (!/^[a-f0-9]{40}$/i.test(parentSha)) throw new Error('unable to determine mock acceptance parent commit');
    const cached = await this.exec('git', ['diff', '--cached', '--name-only']);
    if (cached.stdout.trim()) throw new Error('mock acceptance refuses a pre-staged index');

    const status = parsePorcelainZero((await this.exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout)
      .filter((entry) => !isControlArtifact(entry.path));
    const expectedPaths = proposal.changes.map((change) => normalize(change.path)).sort((a, b) => a.localeCompare(b));
    const actualPaths = status.map((entry) => entry.path).sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error(`mock acceptance working-tree paths differ from verified proposal: expected ${expectedPaths.join(', ')}; found ${actualPaths.join(', ')}`);
    }

    const changedFiles: MockMigrationAcceptancePreview['changedFiles'] = [];
    for (const change of proposal.changes) {
      const relative = normalize(change.path);
      const entry = status.find((candidate) => candidate.path === relative);
      if (!entry) throw new Error(`missing verified mock migration change during acceptance: ${relative}`);
      const expectedStatus = change.operation === 'create' ? '??' : change.operation === 'replace' ? ' M' : ' D';
      if (entry.status !== expectedStatus) throw new Error(`${change.operation} file has unexpected git status during mock acceptance: ${relative} (${entry.status})`);
      let digest: string;
      if (change.operation === 'delete') {
        if (!change.expectedSha256 || !/^[a-f0-9]{64}$/i.test(change.expectedSha256)) throw new Error(`deleted mock source has no reviewed pre-change hash: ${relative}`);
        digest = change.expectedSha256.toLowerCase();
      } else {
        const absolute = path.resolve(this.root, relative);
        if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new Error('mock acceptance path escaped repository root');
        digest = sha256(await readFile(absolute));
      }
      changedFiles.push({ operation: change.operation, path: relative, sha256: digest });
    }

    return stablePreview({ schemaVersion: 1, recordId, branch, parentSha, proposalHash: proposal.proposalHash, changedFiles });
  }

  async accept(input: {
    recordId: string;
    proposal: MockMigrationProposal;
    execution: MockMigrationExecutionEvidence;
    confirmAcceptanceHash: string;
    acceptedBy: string;
  }): Promise<MockMigrationAcceptanceRecord> {
    if (!input.acceptedBy.trim() || input.acceptedBy.length > 120) throw new Error('mock acceptance requires a bounded operator identity');
    const preview = await this.preview(input.recordId, input.proposal, input.execution);
    if (!input.confirmAcceptanceHash || input.confirmAcceptanceHash !== preview.acceptanceHash) throw new Error('mock acceptance requires confirmation of the exact verified tree hash');
    const paths = preview.changedFiles.map((entry) => entry.path);
    await this.exec('git', ['add', '-A', '--', ...paths]);
    const staged = (await this.exec('git', ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean).map(normalize).sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(staged) !== JSON.stringify([...paths].sort((a, b) => a.localeCompare(b)))) {
      await this.exec('git', ['reset']);
      throw new Error('mock acceptance staged paths differ from verified proposal');
    }
    const tree = (await this.exec('git', ['write-tree'])).stdout.trim();
    if (!/^[a-f0-9]{40}$/i.test(tree)) throw new Error('unable to write verified mock acceptance tree');
    const commitResult = await this.exec('git', [
      '-c', 'user.name=AI QA Operator',
      '-c', 'user.email=aiqa@localhost',
      'commit-tree', tree, '-p', preview.parentSha, '-m', `aiqa(beta8): accept mock ${input.recordId}`,
    ]);
    const commitSha = commitResult.stdout.trim();
    if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error('unable to create local mock acceptance commit');
    await this.exec('git', ['reset', '--hard', commitSha]);
    const current = (await this.exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
    if (current !== commitSha) throw new Error('mock acceptance commit did not become the current branch head');
    const remaining = parsePorcelainZero((await this.exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout)
      .filter((entry) => !isControlArtifact(entry.path));
    if (remaining.length > 0) throw new Error('mock acceptance left unexpected non-control working-tree changes');
    return { ...preview, acceptedAt: new Date().toISOString(), acceptedBy: input.acceptedBy.trim(), commitSha };
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
