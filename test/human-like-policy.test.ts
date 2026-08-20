import { describe, expect, it } from 'vitest';
import { HumanLikePolicy } from '../src/planning/human-like-policy.js';
import type { ExplorationCandidate } from '../src/core/types.js';

const candidate = (overrides: Partial<ExplorationCandidate> = {}): ExplorationCandidate => ({
  id: 'button:0:test',
  kind: 'button',
  label: 'Open settings',
  locatorIndex: 0,
  tagName: 'button',
  type: 'button',
  ...overrides,
});

describe('HumanLikePolicy', () => {
  it('allows low-risk exploratory controls in safe mode', () => {
    const result = new HumanLikePolicy().evaluate(candidate(), 'safe');
    expect(result.allowed).toBe(true);
    expect(result.risk).toBe('low');
    expect(result.interestScore).toBeGreaterThan(0);
  });

  it('allows navigation to authentication pages in safe mode', () => {
    const loginLink = candidate({
      id: 'link:0:login',
      kind: 'link',
      label: 'Login',
      href: 'https://example.com/login',
      tagName: 'a',
      type: undefined,
    });
    const result = new HumanLikePolicy().evaluate(loginLink, 'safe');
    expect(result.allowed).toBe(true);
    expect(result.risk).toBe('low');
  });

  it('blocks form submissions in safe mode but permits them in standard mode', () => {
    const submit = candidate({ label: 'Save profile', type: 'submit' });
    expect(new HumanLikePolicy().evaluate(submit, 'safe').allowed).toBe(false);
    expect(new HumanLikePolicy().evaluate(submit, 'standard').allowed).toBe(true);
  });

  it('always blocks irreversible or financially sensitive controls', () => {
    const dangerous = candidate({ label: 'Delete account' });
    const result = new HumanLikePolicy().evaluate(dangerous, 'standard');
    expect(result.allowed).toBe(false);
    expect(result.risk).toBe('blocked');
  });

  it('blocks sensitive fields even when standard mode is enabled', () => {
    const cardField = candidate({
      id: 'field:0:card',
      kind: 'field',
      label: 'Credit card number',
      name: 'card_number',
      tagName: 'input',
      type: 'text',
    });
    const result = new HumanLikePolicy().evaluate(cardField, 'standard');
    expect(result.allowed).toBe(false);
    expect(result.risk).toBe('blocked');
  });
});
