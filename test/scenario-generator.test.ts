import { describe, expect, it } from 'vitest';
import { ScenarioGenerator } from '../src/planning/scenario-generator.js';
import type { ExplorationCandidate } from '../src/core/types.js';
import type { PageStateSnapshot } from '../src/planning/page-state-analyzer.js';

const state: PageStateSnapshot = {
  url: 'https://example.com/login',
  title: 'Sign in',
  headings: ['Welcome back'],
  bodySample: 'Sign in or reset your password',
  formCount: 1,
  fieldCount: 2,
  searchFieldCount: 0,
  buttonCount: 2,
  linkCount: 3,
  hasDialog: false,
  hasTable: false,
  archetypes: ['authentication', 'form'],
};

const candidate = (label: string, id: string): ExplorationCandidate => ({
  id,
  kind: 'link',
  label,
  href: `https://example.com/${id}`,
  locatorIndex: 0,
  tagName: 'a',
});

describe('ScenarioGenerator', () => {
  it('creates intents from multiple page archetypes', () => {
    const scenarios = new ScenarioGenerator().generate(state);
    expect(scenarios.map((scenario) => scenario.id)).toContain('auth-entry');
    expect(scenarios.map((scenario) => scenario.id)).toContain('form-validation');
  });

  it('boosts controls that match active scenario goals', () => {
    const generator = new ScenarioGenerator();
    const scenarios = generator.generate(state);
    const reset = generator.scoreCandidate(candidate('Forgot password', 'forgot'), scenarios);
    const unrelated = generator.scoreCandidate(candidate('Company news', 'news'), scenarios);
    expect(reset.boost).toBeGreaterThan(unrelated.boost);
    expect(reset.reasons.some((reason) => reason.includes('auth-entry'))).toBe(true);
  });
});
