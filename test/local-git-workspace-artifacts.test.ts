import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalGitBackendWorkspace } from '../src/backend/local-git-backend-workspace.js';

const exec = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true }); });

describe('LocalGitBackendWorkspace control-artifact boundary', () => {
  it('allows untracked AI QA evidence without treating user files as clean and preserves evidence during rollback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiqa-workspace-artifacts-'));
    cleanup.push(root);
    await writeFile(path.join(root, 'package.json'), '{"private":true}\n');
    await exec('git', ['init'], { cwd: root });
    await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: root });
    await exec('git', ['config', 'user.name', 'QA Test'], { cwd: root });
    await exec('git', ['add', 'package.json'], { cwd: root });
    await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
    await exec('git', ['switch', '-c', 'feature/work'], { cwd: root });

    const artifactDir = path.join(root, '.qa-beta9');
    await mkdir(artifactDir, { recursive: true });
    const artifact = path.join(artifactDir, 'immutable.json');
    await writeFile(artifact, '{"keep":true}\n');

    const workspace = new LocalGitBackendWorkspace(root, 'aiqa/fix');
    expect(await workspace.isClean()).toBe(true);

    const unrelated = path.join(root, 'user-untracked.txt');
    await writeFile(unrelated, 'do not ignore me\n');
    expect(await workspace.isClean()).toBe(false);
    await rm(unrelated);

    const original = await workspace.currentBranch();
    const execution = await workspace.createBranch('B9-FIX-ARTIFACT');
    const generated = path.join(root, 'generated-by-failed-attempt.txt');
    await writeFile(generated, 'temporary\n');
    await workspace.rollback(original, execution);

    expect(await workspace.currentBranch()).toBe('feature/work');
    expect(await readFile(artifact, 'utf8')).toContain('keep');
    await expect(readFile(generated, 'utf8')).rejects.toThrow();
  });
});
