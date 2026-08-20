import { describe, expect, it } from 'vitest';
import { approveWorkItem, computeWorkItemScopeHash, validateWorkPlan, type WorkItem, type WorkPlan } from '../src/planning/work-item.js';
import { buildFeatureBlueprint, buildFeaturePlanningSession, validateFeaturePlanningAnswers, type FeaturePlanningAnswer, type ProductOpportunity } from '../src/planning/feature-planner.js';

function execution(mutationAllowed = false) {
  return { mutationAllowed, allowedPaths: mutationAllowed ? ['src/**'] : [], forbiddenPaths: ['.git/**'], maxAttempts: 3, requireCleanWorkspace: true, requireIsolatedBranch: true, requireTargetedTests: true, requireRegressionTests: true, requireBeta7Qa: true };
}
function item(id: string, dependencies: string[] = []): WorkItem {
  return { id, kind: 'feature', title: id, goal: id, why: id, source: [{ type: 'user-request', reference: 'req-1' }], status: 'planned', priority: 'P1', confidence: .9, dependencies, affectedModules: [], affectedFiles: [], designRequirements: [], implementationPlan: [], securityImpact: [], risks: [], acceptanceCriteria: ['done'], requiredTests: ['test'], qaStrategy: ['Beta.7'], approval: { required: true, approved: false }, execution: execution(false) };
}
function plan(items: WorkItem[]): WorkPlan { return { schemaVersion: 1, generatedAt: new Date().toISOString(), project: 'demo', purpose: 'test', items }; }

describe('shared work planning domain', () => {
  it('rejects duplicate ids, missing dependencies and dependency cycles', () => {
    expect(validateWorkPlan(plan([item('A'), item('A')])).valid).toBe(false);
    expect(validateWorkPlan(plan([item('A', ['MISSING'])])).missingDependencies).toEqual(['A->MISSING']);
    const cyclic = validateWorkPlan(plan([item('A', ['B']), item('B', ['A'])]));
    expect(cyclic.valid).toBe(false);
    expect(cyclic.cycles.length).toBeGreaterThan(0);
  });

  it('does not allow a mutating task without an explicit bounded approval', () => {
    const unsafe = item('A');
    unsafe.execution = execution(true);
    expect(validateWorkPlan(plan([unsafe])).unsafeExecutionGates).toEqual(['A']);
  });

  it('approves only after dependencies complete and only with repository-relative paths', () => {
    const p = plan([item('A'), item('B', ['A'])]);
    expect(() => approveWorkItem(p, 'B', { approvedBy: 'owner', allowedPaths: ['src/**'] })).toThrow(/dependencies/);
    p.items[0]!.status = 'completed';
    expect(() => approveWorkItem(p, 'B', { approvedBy: 'owner', allowedPaths: ['../escape'] })).toThrow(/bounded/);
    approveWorkItem(p, 'B', { approvedBy: 'owner', allowedPaths: ['src/backend/**'] });
    expect(p.items[1]).toMatchObject({ status: 'approved', approval: { approved: true }, execution: { mutationAllowed: true, allowedPaths: ['src/backend/**'] } });
    expect(p.items[1]!.approval.scopeHash).toBe(computeWorkItemScopeHash(p.items[1]!, ['src/backend/**']));
    expect(validateWorkPlan(p).valid).toBe(true);
  });

  it('invalidates approval when the approved task scope changes afterwards', () => {
    const p = plan([item('A')]);
    approveWorkItem(p, 'A', { approvedBy: 'owner', allowedPaths: ['src/backend/**'] });
    expect(validateWorkPlan(p).valid).toBe(true);
    p.items[0]!.implementationPlan.push('new unreviewed behavior');
    expect(validateWorkPlan(p).unsafeExecutionGates).toEqual(['A']);
  });
});

describe('feature planning mode', () => {
  const opportunity: ProductOpportunity = {
    id: 'P-014', source: 'ux-opportunity', title: 'Learning Performance Center', observation: 'Progress is fragmented across three modules.', userValue: 'Give learners one place to understand progress and weak areas.', expectedImpact: 'high', estimatedEffort: 'medium', confidence: .89,
    evidence: ['UX-014', 'route:/vocabulary', 'route:/sentence-grammar'], affectedAreas: ['vocabulary', 'sentence-grammar', 'practice'], designSystemConstraints: ['Reuse existing LeeEng card, typography and navigation patterns'],
  };

  it('requires evidence before proposing a planning session and never self-confirms questions', () => {
    const session = buildFeaturePlanningSession({ project: 'LeeEngUI', opportunity, currentProductUnderstanding: ['Vocabulary progress exists', 'Grammar progress exists'] });
    expect(session.questions.length).toBeGreaterThanOrEqual(6);
    expect(session.generationBlockedUntil.length).toBe(session.questions.filter((question) => question.required).length);
    expect(validateFeaturePlanningAnswers(session, []).ready).toBe(false);
  });

  it('rejects unconfirmed/invalid option answers and creates a gated task graph only after confirmation', () => {
    const session = buildFeaturePlanningSession({ project: 'LeeEngUI', opportunity, currentProductUnderstanding: ['Current design system must be preserved'] });
    const answers: FeaturePlanningAnswer[] = session.questions.map((question) => ({
      questionId: question.id,
      value: question.kind === 'boolean' ? true : question.kind === 'multi' ? [question.options?.[0] ?? 'Confirmed'] : question.options?.[0] ?? 'Confirmed product goal',
      confirmed: true,
    }));
    expect(validateFeaturePlanningAnswers(session, answers).ready).toBe(true);
    const blueprint = buildFeatureBlueprint({
      session, answers, selectedAlternativeId: 'balanced', userFlow: ['Open performance center', 'Review module progress', 'Open weak-area recommendation'],
      informationArchitecture: ['Learning > Performance Center'], frontendRequirements: ['Summary cards', 'Module progress drilldown'], backendRequirements: ['Aggregated progress endpoint'], dataRequirements: ['Reuse existing progress records'], securityRequirements: ['Users may read only their own progress'],
    });
    expect(blueprint.workPlan.items.map((candidate) => candidate.id)).toEqual(['FEAT-P-014-DESIGN', 'FEAT-P-014-FRONTEND', 'FEAT-P-014-BACKEND', 'FEAT-P-014-INTEGRATE']);
    expect(blueprint.workPlan.items.every((candidate) => candidate.approval.required && !candidate.approval.approved && !candidate.execution.mutationAllowed)).toBe(true);
    expect(validateWorkPlan(blueprint.workPlan).valid).toBe(true);
  });
});
