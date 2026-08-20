import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { MockMigrationRecord } from './mock-migration.js';
import { safeBackendPath, validateBackendVerificationCommand } from './backend-executor.js';
import type { BackendCommandResult, BackendVerificationCommand } from './executor-types.js';
import type { MockMigrationFileChange, MockMigrationSourceContext, MockMigrationWorkspace } from './mock-migration-executor.js';

const MAX_CONTEXT_BYTES = 160_000;
const MAX_OUTPUT_CHARS = 30_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class LocalGitMockMigrationWorkspace implements MockMigrationWorkspace {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  async currentBranch(): Promise<string> {
    const result = await this.exec('git', ['branch', '--show-current'], true);
    if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error('unable to determine current git branch');
    return result.stdout.trim();
  }

  async isClean(): Promise<boolean> {
    const result = await this.exec('git', ['status', '--porcelain=v1'], true);
    return result.exitCode === 0 && result.stdout.trim() === '';
  }

  async sourceContext(record: MockMigrationRecord): Promise<{ source: MockMigrationSourceContext; existingSeed?: MockMigrationSourceContext }> {
    const source = await this.readContext(record.source, true);
    if (!source) throw new Error(`mock source is not available: ${record.source}`);
    const existingSeed = record.seedDestination ? await this.readContext(record.seedDestination, false) : undefined;
    return { source, ...(existingSeed ? { existingSeed } : {}) };
  }

  async createBranch(recordId: string): Promise<string> {
    const normalized = recordId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 60).replace(/^-|-$/g, '');
    if (!normalized) throw new Error('mock migration record id cannot produce a safe branch name');
    const branch = `aiqa/mock/${normalized}`;
    const result = await this.exec('git', ['switch', '-c', branch], true);
    if (result.exitCode !== 0) throw new Error(`unable to create isolated mock migration branch: ${result.stderr}`);
    return branch;
  }

  async applyChange(change: MockMigrationFileChange, record: MockMigrationRecord): Promise<void> {
    if (!safeBackendPath(change.path)) throw new Error(`unsafe mock migration path: ${change.path}`);
    const allowed = change.path === record.source || change.path === record.seedDestination;
    if (!allowed) throw new Error(`mock migration path is outside approved source/destination: ${change.path}`);
    const absolute = path.resolve(this.root, change.path);
    if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new Error('mock migration change escaped workspace root');

    if (change.operation === 'create') {
      if (typeof change.content !== 'string') throw new Error(`create requires content: ${change.path}`);
      await mkdir(path.dirname(absolute), { recursive: true });
      try {
        await writeFile(absolute, change.content, { encoding: 'utf8', flag: 'wx' });
      } catch (error: unknown) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
        if (code === 'EEXIST') throw new Error(`create target already exists: ${change.path}`);
        throw error;
      }
      return;
    }

    const current = await readFile(absolute, 'utf8');
    if (!change.expectedSha256 || sha256(current) !== change.expectedSha256) throw new Error(`source changed since reviewed mock migration proposal: ${change.path}`);
    if (change.operation === 'delete') {
      if (change.path !== record.source) throw new Error('mock migration executor may delete only the exact approved mock source');
      await rm(absolute, { force: false });
      return;
    }
    if (typeof change.content !== 'string') throw new Error(`replace requires content: ${change.path}`);
    await writeFile(absolute, change.content, 'utf8');
  }

  async run(command: BackendVerificationCommand): Promise<BackendCommandResult> {
    const error = validateBackendVerificationCommand(command);
    if (error) throw new Error(error);
    return this.exec(command.program, command.args, false);
  }

  async rollback(originalBranch: string, executionBranch: string): Promise<void> {
    await this.exec('git', ['reset', '--hard', 'HEAD'], true);
    await this.exec('git', ['clean', '-fd'], true);
    await this.exec('git', ['switch', originalBranch], true);
    await this.exec('git', ['branch', '-D', executionBranch], true);
  }

  private async readContext(relative: string, required: boolean): Promise<MockMigrationSourceContext | undefined> {
    if (!safeBackendPath(relative)) throw new Error(`unsafe mock migration context path: ${relative}`);
    const tracked = await this.exec('git', ['ls-files', '--error-unmatch', relative], true);
    if (tracked.exitCode !== 0) {
      if (required) throw new Error(`mock source is not a tracked file: ${relative}`);
      return undefined;
    }
    const absolute = path.resolve(this.root, relative);
    if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new Error('mock migration context escaped workspace root');
    const buffer = await readFile(absolute);
    if (buffer.length > MAX_CONTEXT_BYTES || buffer.includes(0)) throw new Error(`mock migration context is binary or too large: ${relative}`);
    const content = buffer.toString('utf8');
    return { path: relative, sha256: sha256(content), content };
  }

  private exec(program: string, args: string[], workspaceOwned: boolean): Promise<BackendCommandResult> {
    if (!workspaceOwned && program === 'git') throw new Error('git is workspace-owned, not model-owned');
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd: this.root, shell: false, env: process.env });
      let stdout = '';
      let stderr = '';
      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        const value = chunk.toString('utf8');
        if (target === 'stdout') stdout = `${stdout}${value}`.slice(-MAX_OUTPUT_CHARS);
        else stderr = `${stderr}${value}`.slice(-MAX_OUTPUT_CHARS);
      };
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  }
}
