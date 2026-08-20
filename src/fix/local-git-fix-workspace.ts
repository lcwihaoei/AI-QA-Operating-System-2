import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Finding } from '../core/types.js';
import { safeFixPath, validateFixCommand } from './fix-policy.js';
import type { FixCommand, FixCommandResult, FixFileReplacement, FixSourceFile, FixWorkspace } from './fix-types.js';

const MAX_CONTEXT_FILE_BYTES = 120_000;
const MAX_TRACKED_FILES = 2_000;
const MAX_OUTPUT_CHARS = 20_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokens(finding: Finding): string[] {
  return [...new Set(`${finding.title} ${finding.message}`
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .filter((value) => value.length >= 4)
    .slice(0, 30))];
}

export class LocalGitFixWorkspace implements FixWorkspace {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  async currentBranch(): Promise<string> {
    const result = await this.exec('git', ['branch', '--show-current']);
    if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error('unable to determine current git branch');
    return result.stdout.trim();
  }

  async isClean(): Promise<boolean> {
    const result = await this.exec('git', ['status', '--porcelain=v1']);
    return result.exitCode === 0 && result.stdout.trim() === '';
  }

  async collectContext(finding: Finding, maxFiles: number): Promise<FixSourceFile[]> {
    const listed = await this.exec('git', ['ls-files']);
    if (listed.exitCode !== 0) throw new Error('unable to enumerate tracked source files');
    const candidates = listed.stdout.split('\n').filter(Boolean).slice(0, MAX_TRACKED_FILES).filter(safeFixPath);
    const wanted = tokens(finding);
    const scored: Array<{ score: number; file: FixSourceFile }> = [];

    for (const relative of candidates) {
      const absolute = path.resolve(this.root, relative);
      if (!absolute.startsWith(`${this.root}${path.sep}`) && absolute !== this.root) continue;
      let content: string;
      try {
        const buffer = await readFile(absolute);
        if (buffer.length > MAX_CONTEXT_FILE_BYTES || buffer.includes(0)) continue;
        content = buffer.toString('utf8');
      } catch {
        continue;
      }
      const haystack = `${relative}\n${content.slice(0, MAX_CONTEXT_FILE_BYTES)}`.toLowerCase();
      let score = /(^|\/)(src|lib|app|packages)\//.test(relative) ? 2 : 0;
      for (const token of wanted) if (haystack.includes(token)) score += relative.toLowerCase().includes(token) ? 8 : 1;
      if (score <= 0) continue;
      scored.push({ score, file: { path: relative, sha256: sha256(content), content } });
    }

    return scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      .slice(0, Math.max(1, Math.min(maxFiles, 8)))
      .map(({ file }) => file);
  }

  async createBranch(branch: string): Promise<void> {
    if (!/^aiqa\/fix\/[a-z0-9_-]+$/.test(branch)) throw new Error('fix branch name is outside policy');
    const result = await this.exec('git', ['switch', '-c', branch]);
    if (result.exitCode !== 0) throw new Error(`unable to create isolated fix branch: ${result.stderr}`);
  }

  async replaceFile(replacement: FixFileReplacement): Promise<void> {
    if (!safeFixPath(replacement.path)) throw new Error(`unsafe fix path ${replacement.path}`);
    const absolute = path.resolve(this.root, replacement.path);
    if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new Error('replacement escaped workspace root');
    const current = await readFile(absolute, 'utf8');
    if (sha256(current) !== replacement.expectedSha256) throw new Error(`source changed since proposal: ${replacement.path}`);
    await writeFile(absolute, replacement.content, 'utf8');
  }

  async run(command: FixCommand): Promise<FixCommandResult> {
    const error = validateFixCommand(command);
    if (error) throw new Error(error);
    return this.exec(command.program, command.args);
  }

  async rollback(originalBranch: string, fixBranch: string): Promise<void> {
    await this.exec('git', ['reset', '--hard', 'HEAD']);
    await this.exec('git', ['switch', originalBranch]);
    await this.exec('git', ['branch', '-D', fixBranch]);
  }

  private exec(program: string, args: string[]): Promise<FixCommandResult> {
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
