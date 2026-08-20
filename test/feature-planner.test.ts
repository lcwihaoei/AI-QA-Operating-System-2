import { describe, expect, it } from 'vitest';
import {
  buildFeatureBlueprint,
  buildFeaturePlanningSession,
  validateFeaturePlanningAnswers,
  type FeaturePlanningAnswer,
  type ProductOpportunity,
} from '../src/planning/feature-planner.js';
import { validateWorkPlan } from '../src/planning/work-item.js';

function opportunity(): ProductOpportunity {
  return {
    id: 'guided-review',
    source: 'user-request',
    title: 'Guided review workflow',
    observation: 'Operators need a clearer way to review proposed changes before execution.',
    userValue: 'Reduce approval mistakes and make scope/risk visible before code changes.',
    expectedImpact: 'high',
    estimatedEffort: 'medium',
    confidence: 1,
    evidence: ['dashboard:user-request:guided-review'],
    affectedAreas: ['management-dashboard', 'planning'],
    designSystemConstraints: ['Reuse the existing dashboard visual language and bilingual controls.'],
  };
}

function confirmedAnswers(session: ReturnType<typeof buildFeaturePlanningSession>): FeaturePlanningAnswer[] {
  return session.questions.map((question) => ({
    questionId: question.id,
    value: question.kind === 'boolean'
      ? true
      : question.kind === 'multi'
        ? [question.options![0]!]
        : question.kind === 'single'
          ? question.options![0]!
          : 'Make approval scope and expected outcome clear before execution.',
    confirmed: true,
  }));
}

describe('product feature planner', () => {
  it('keeps blueprint generation blocked until every required product decision is explicitly confirmed', () => {
    const session = buildFeaturePlanningSession({ project: 'demo', opportunity: opportunity(), currentProductUnderstanding: ['Existing dark/light bilingual management dashboard.'] });
    const partial = confirmedAnswers(session).slice(0, 2);
    const validation = validateFeaturePlanningAnswers(session, partial);
    expect(validation.ready).toBe(false);
    expect(validation.missing.length).toBeGreaterThan(0);

    const unconfirmed = confirmedAnswers(session);
    unconfirmed[0] = { ...unconfirmed[0]!, confirmed: false };
    expect(validateFeaturePlanningAnswers(session, unconfirmed)).toMatchObject({ ready: false, unconfirmed: ['feature-goal-confirmation'] });
  });

  it('builds a safe dependency-ordered full-stack feature work plan without enabling source mutation', () => {
    const session = buildFeaturePlanningSession({ project: 'demo', opportunity: opportunity(), currentProductUnderstanding: ['Existing dashboard shell', 'Beta.7 evidence gate'] });
    const blueprint = buildFeatureBlueprint({
      session,
      answers: confirmedAnswers(session),
      selectedAlternativeId: 'balanced',
      userFlow: ['Owner opens the feature planner.', 'Owner reviews product decisions.', 'Owner confirms the blueprint before implementation.'],
      informationArchitecture: ['Features navigation entry', 'Planning interview', 'Blueprint summary'],
      frontendRequirements: ['Reuse the current dashboard components.', 'Support Traditional Chinese and English.'],
      backendRequirements: ['Persist only bounded planning artifacts.', 'Do not execute implementation from planning actions.'],
      dataRequirements: ['Store confirmed answers and blueprint metadata without secrets.'],
      securityRequirements: ['Require explicit approval before any future mutation.', 'Keep default-deny execution boundaries.'],
    });

    expect(blueprint.selectedAlternative.id).toBe('balanced');
    expect(blueprint.workPlan.items.map((item) => item.kind)).toEqual(['feature', 'frontend', 'backend', 'qa']);
    expect(blueprint.workPlan.items.every((item) => item.execution.mutationAllowed === false)).toBe(true);
    expect(blueprint.workPlan.items.every((item) => item.approval.approved === false)).toBe(true);
    expect(blueprint.workPlan.items.at(-1)?.dependencies).toEqual([
      'FEAT-guided-review-FRONTEND',
      'FEAT-guided-review-BACKEND',
    ]);
    expect(validateWorkPlan(blueprint.workPlan).valid).toBe(true);
  });
});
