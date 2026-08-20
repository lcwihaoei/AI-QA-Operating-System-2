import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FeaturePlannerDashboardService } from '../src/control/feature-planner-service.js';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function service() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-feature-planner-'));
  roots.push(root);
  return new FeaturePlannerDashboardService(path.join(root, '.qa-features'));
}

function answerFor(question: any): string | string[] | boolean {
  if (question.kind === 'boolean') return true;
  if (question.kind === 'multi') return [question.options[0]];
  if (question.kind === 'single') return question.options[0];
  return 'Improve the approved operator outcome without changing unrelated workflows.';
}

describe('FeaturePlannerDashboardService', () => {
  it('persists an explicit interview and freezes a safe blueprint only after all required answers are confirmed', async () => {
    const planner = await service();
    expect(await planner.summary()).toMatchObject({ available: false, phase: 'empty' });

    const created = await planner.create({
      project: 'demo',
      title: 'Guided approval review',
      observation: 'Approval scope is difficult to review before source changes.',
      userValue: 'Make product intent, scope and risks visible before implementation.',
      expectedImpact: 'high',
      estimatedEffort: 'medium',
      affectedAreas: ['dashboard', 'planning'],
      designSystemConstraints: ['Reuse the existing bilingual management dashboard.'],
      currentProductUnderstanding: ['Beta.7 evidence gate exists.', 'Beta.9 source mutation is separately approval-gated.'],
    });
    expect(created.phase).toBe('interview');
    expect(created.session?.opportunity.source).toBe('user-request');

    for (const question of created.session!.questions) {
      const next = await planner.answer(question.id, answerFor(question), true);
      expect(next.answers?.some((answer) => answer.questionId === question.id && answer.confirmed)).toBe(true);
    }
    expect((await planner.summary()).phase).toBe('ready-for-blueprint');

    const frozen = await planner.blueprint({
      selectedAlternativeId: 'balanced',
      userFlow: ['Open feature planner', 'Review and confirm decisions', 'Freeze the implementation contract'],
      informationArchitecture: ['Feature planner entry', 'Decision interview', 'Blueprint review'],
      frontendRequirements: ['Reuse dashboard cards and forms', 'Support 繁體 | English and responsive layouts'],
      backendRequirements: ['Store planning artifacts only; source mutation stays disabled'],
      dataRequirements: ['Do not persist secrets in planning artifacts'],
      securityRequirements: ['Explicit approval before future implementation', 'Default deny for source mutation'],
    });
    expect(frozen).toMatchObject({ available: true, phase: 'blueprint-ready', workPlanValid: true });
    expect(frozen.blueprint?.workPlan.items.every((item) => item.execution.mutationAllowed === false)).toBe(true);

    await expect(planner.answer(created.session!.questions[0]!.id, 'changed', true)).rejects.toThrow(/already frozen/i);
    await expect(planner.blueprint({
      selectedAlternativeId: 'balanced', userFlow: ['x'], informationArchitecture: [], frontendRequirements: ['x'], backendRequirements: [], dataRequirements: [], securityRequirements: ['x'],
    })).rejects.toThrow(/already exists/i);
  });

  it('rejects unsupported option values instead of silently accepting inferred product decisions', async () => {
    const planner = await service();
    const created = await planner.create({
      project: 'demo', title: 'Safe feature', observation: 'Need explicit scope.', userValue: 'Safer changes.', expectedImpact: 'medium', estimatedEffort: 'low',
      affectedAreas: [], designSystemConstraints: [], currentProductUnderstanding: [],
    });
    const release = created.session!.questions.find((question) => question.id === 'release-strategy')!;
    await expect(planner.answer(release.id, 'Ship everywhere immediately', true)).rejects.toThrow(/unsupported option/i);
  });
});
