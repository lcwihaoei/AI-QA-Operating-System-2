import { describe, expect, it } from 'vitest';
import { SyntheticInputStrategy } from '../src/planning/synthetic-input-strategy.js';
import type { ExplorationCandidate } from '../src/core/types.js';

const field = (overrides: Partial<ExplorationCandidate> = {}): ExplorationCandidate => ({
  id: 'field:0:email',
  kind: 'field',
  label: 'Email',
  locatorIndex: 0,
  tagName: 'input',
  type: 'email',
  ...overrides,
});

describe('SyntheticInputStrategy', () => {
  it('uses synthetic values rather than user data', () => {
    const plan = new SyntheticInputStrategy().plan(field());
    expect(plan.action).toBe('fill');
    if (plan.action === 'fill') expect(plan.value).toBe('qa@example.com');
  });

  it('supports textarea and select exploration', () => {
    expect(new SyntheticInputStrategy().plan(field({ tagName: 'textarea', type: 'textarea' })).action).toBe('fill');
    expect(new SyntheticInputStrategy().plan(field({ tagName: 'select', type: 'select' })).action).toBe('select');
  });

  it('skips stateful unsupported controls', () => {
    expect(new SyntheticInputStrategy().plan(field({ type: 'file' })).action).toBe('skip');
    expect(new SyntheticInputStrategy().plan(field({ type: 'checkbox' })).action).toBe('skip');
  });
});
