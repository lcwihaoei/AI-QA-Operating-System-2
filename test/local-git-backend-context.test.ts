import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalGitBackendWorkspace } from '../src/backend/local-git-backend-workspace.js';
import { approveWorkItem, type WorkItem, type WorkPlan } from '../src/planning/work-item.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

function item(): WorkItem {
  return {
    id: 'B8-MOD-001', kind: 'backend', title: 'Users backend slice', goal: 'Implement users API', why: 'Frontend evidence',
    source: [{ type: 'frontend-discovery', reference: 'src/users.ts' }], status: 'planned', priority: 'P1', confidence: 1,
    dependencies: [], affectedModules: ['users'], affectedFiles: [], designRequirements: [], implementationPlan: ['GET /api/users'],
    securityImpact: ['deny by default'], risks: ['scope drift'], acceptanceCriteria: ['tests pass'], requiredTests: ['targeted'], qaStrategy: ['Beta.7'],
    approval: { required: true, approved: false },
    execution: { mutationAllowed: false, allowedPaths: [], forbiddenPaths: ['.git/**', '.github/workflows/**', '**/.env*'], maxAttempts: 3, requireCleanWorkspace: true, requireIsolatedBranch: true, requireTargetedTests: true, requireRegressionTests: true, requireBeta7Qa: true },
  };
}

describe('LocalGitBackendWorkspace model context', () => {
  it('can read bounded frontend evidence outside the approved write scope while writes remain backend-only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta8-context-'));
    roots.push(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'context-fixture' }));
    await writeFile(path.join(root, 'src', 'users.ts'), `export async function users(){return fetch('/api/users').then(r=>r.json())}\n`);
    await writeFile(path.join(root, 'src', 'other.ts'), `export const unrelated = true;\n`);
    await exec('git', ['init'], { cwd: root });
    await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: root });
    await exec('git', ['config', 'user.name', 'QA Test'], { cwd: root });
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['commit', '-m', 'fixture'], { cwd: root });

    const plan: WorkPlan = { schemaVersion: 1, generatedAt: new Date().toISOString(), project: 'demo', purpose: 'backend', items: [item()] };
    approveWorkItem(plan, 'B8-MOD-001', { approvedBy: 'owner', allowedPaths: ['backend/**'] });
    const workspace = new LocalGitBackendWorkspace(root);
    const files = await workspace.collectContext(plan.items[0]!, 3);

    expect(files.map((file) => file.path)).toContain('src/users.ts');
    expect(files.find((file) => file.path === 'src/users.ts')?.content).toContain('/api/users');
    expect(plan.items[0]!.execution.allowedPaths).toEqual(['backend/**']);
  });
});
