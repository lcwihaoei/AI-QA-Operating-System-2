import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Beta8DashboardActionService } from '../src/control/beta8-action-service.js';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture(): Promise<{ repo: string; artifacts: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta8-dashboard-'));
  roots.push(root);
  const repo = path.join(root, 'frontend');
  const artifacts = path.join(root, 'artifacts');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'beta8-ui', dependencies: { react: '^19.0.0' } }));
  await writeFile(path.join(repo, 'src', 'app.tsx'), `
    const mockUsers = [{ id: 1, name: 'Demo' }];
    export async function loadUsers(){ return fetch('/api/users').then(r => r.json()); }
    export function App(){ return <form action="/api/users"><input name="email" /><button>Save</button></form>; }
    export { mockUsers };
  `);
  return { repo, artifacts };
}

function answerFor(question: { kind: string; options?: string[]; id: string }): string | string[] | boolean {
  if (question.kind === 'boolean') return true;
  if (question.kind === 'multi') return [question.options?.[0] ?? 'None'];
  if (question.kind === 'single') return question.options?.[0] ?? 'Other';
  if (question.id === 'deployment-target') return 'Docker container on a managed VM';
  return 'Confirmed by owner';
}

describe('Beta.8 governed dashboard action service', () => {
  it('discovers the frontend, requires explicit interview decisions, then creates immutable security-first plans', async () => {
    const { repo, artifacts } = await fixture();
    const service = new Beta8DashboardActionService({ repoPath: repo, artifactRoot: artifacts });

    const discovered = await service.discover();
    expect(discovered.phase).toBe('discovered');
    expect(discovered.discovery?.filesScanned).toBeGreaterThan(0);
    expect(discovered.interview?.validation.readyForBlueprint).toBe(false);
    expect(discovered.interview?.validation.missing.length).toBeGreaterThan(0);

    for (const round of discovered.interview!.rounds) {
      for (const question of round.questions) {
        if (!question.required && !question.requiresExplicitConfirmation) continue;
        await service.answer({ questionId: question.id, value: answerFor(question), confirmed: true });
      }
    }

    const ready = await service.summary();
    expect(ready.phase).toBe('ready-for-blueprint');
    expect(ready.interview?.validation.readyForBlueprint).toBe(true);

    const generated = await service.generateBlueprint();
    expect(generated.phase).toBe('blueprint-ready');
    expect(generated.blueprint?.securityControls).toBeGreaterThan(0);
    expect(generated.blueprint?.tasks).toBeGreaterThan(0);
    expect(generated.blueprint?.workPlanValid).toBe(true);
    expect(generated.blueprint?.workItems.every((item) => item.status === 'planned')).toBe(true);

    await expect(service.generateBlueprint()).rejects.toThrow(/already exists/i);
    await expect(service.discover()).rejects.toThrow(/blueprint already exists/i);
  });

  it('rejects an unconfirmed answer for an explicit architecture decision', async () => {
    const { repo, artifacts } = await fixture();
    const service = new Beta8DashboardActionService({ repoPath: repo, artifactRoot: artifacts });
    await service.discover();
    await expect(service.answer({ questionId: 'backend-language', value: 'Go', confirmed: false })).rejects.toThrow(/explicit confirmation/i);
  });
});
