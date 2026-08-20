import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { WorkItem } from '../planning/work-item.js';
import { pathAllowedForWorkItem, safeBackendPath, validateBackendVerificationCommand } from './backend-executor.js';
import type { BackendCommandResult, BackendExecutionWorkspace, BackendFileChange, BackendSourceContext, BackendVerificationCommand } from './executor-types.js';

const MAX_CONTEXT_FILE_BYTES = 120_000;
const MAX_TRACKED_FILES = 5_000;
const MAX_OUTPUT_CHARS = 30_000;
const MANIFEST_FILES = new Set([
  'package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'composer.json', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pubspec.yaml', 'README.md',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeGitPath(value: string): string {
  return value.replace(/^\.\//, '').replace(/\\/g, '/');
}

export class LocalGitBackendWorkspace implements BackendExecutionWorkspace {
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

  async collectContext(item: WorkItem, maxFiles: number): Promise<BackendSourceContext[]> {
    const listed = await this.exec('git', ['ls-files'], true);
    if (listed.exitCode !== 0) throw new Error('unable to enumerate tracked source files');
    const tracked = listed.stdout.split('\n').map(normalizeGitPath).filter(Boolean).slice(0, MAX_TRACKED_FILES);
    const candidates = tracked.filter((relative) => {
      if (!safeBackendPath(relative)) return false;
      if (MANIFEST_FILES.has(relative) || MANIFEST_FILES.has(path.posix.basename(relative))) return true;
      if (item.affectedFiles.includes(relative)) return true;
      return item.execution.allowedPaths.some((pattern) => {
        if (pattern.endsWith('/**')) {
          const base = pattern.slice(0, -3).replace(/\/$/, '');
          return relative === base || relative.startsWith(`${base}/`);
        }
        return relative === pattern;
      });
    });

    const preferred = [...new Set([
      ...tracked.filter((relative) => MANIFEST_FILES.has(relative) || MANIFEST_FILES.has(path.posix.basename(relative))),
      ...item.affectedFiles,
      ...candidates,
    ])].filter((relative) => tracked.includes(relative) && safeBackendPath(relative));

    const files: BackendSourceContext[] = [];
    for (const relative of preferred) {
      if (files.length >= maxFiles) break;
      const absolute = path.resolve(this.root, relative);
      if (!absolute.startsWith(`${this.root}${path.sep}`)) continue;
      try {
        const buffer = await readFile(absolute);
        if (buffer.length > MAX_CONTEXT_FILE_BYTES || buffer.includes(0)) continue;
        const content = buffer.toString('utf8');
        files.push({ path: relative, sha256: sha256(content), content });
      } catch {
        continue;
      }
    }
    return files;
  }

  async createBranch(itemId: string): Promise<string> {
    const normalized = itemId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 60).replace(/^-|-$/g, '');
    if (!normalized) throw new Error('work item id cannot produce a safe branch name');
    const branch = `aiqa/backend/${normalized}`;
    const result = await this.exec('git', ['switch', '-c', branch], true);
    if (result.exitCode !== 0) throw new Error(`unable to create isolated backend branch: ${result.stderr}`);
    return branch;
  }

  async applyChange(change: BackendFileChange, item: WorkItem): Promise<void> {
    if (!pathAllowedForWorkItem(change.path, item)) throw new Error(`change escaped approved task scope: ${change.path}`);
    const absolute = path.resolve(this.root, change.path);
    if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new Error('change escaped workspace root');

    if (change.operation === 'create') {
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
    if (sha256(current) !== change.expectedSha256) throw new Error(`source changed since proposal: ${change.path}`);
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
