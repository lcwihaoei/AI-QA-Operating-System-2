import { describe, expect, it } from 'vitest';
import { observePageVisibility } from '../src/state/page-state-observer.js';

const base = {
  stateId: 'state-1',
  url: 'http://127.0.0.1:5173/',
  observedAt: '2026-08-21T00:00:00.000Z',
  viewportWidth: 1440,
  viewportHeight: 1000,
};

describe('State Observer visibility semantics', () => {
  it('recognizes an offscreen controlled region as intentionally hidden only when its owner is collapsed', () => {
    const observation = observePageVisibility({
      ...base,
      rect: { x: -160, y: 80, width: 240, height: 715 },
      controlledBy: 'button[aria-controls="appMenubar"]',
      ownerExpanded: false,
      transformed: true,
    });

    expect(observation.visibility).toBe('intentionally-hidden');
    expect(observation.reasons.join(' ')).toContain('collapsed');
  });

  it('does not treat an unrelated transform as proof of hidden state', () => {
    const observation = observePageVisibility({
      ...base,
      rect: { x: 20, y: 20, width: 100, height: 40 },
      transformed: true,
    });

    expect(observation.visibility).toBe('visible');
    expect(observation.reasons.join(' ')).toContain('does not by itself prove hidden state');
  });

  it('marks unexplained offscreen geometry as unknown rather than a product defect', () => {
    const observation = observePageVisibility({
      ...base,
      rect: { x: -140, y: 25, width: 64, height: 29 },
      transformed: true,
    });

    expect(observation.visibility).toBe('unknown');
  });

  it('honors explicit aria-hidden and inert state', () => {
    expect(observePageVisibility({
      ...base,
      rect: { x: 0, y: 0, width: 100, height: 40 },
      ariaHidden: true,
    }).visibility).toBe('intentionally-hidden');

    expect(observePageVisibility({
      ...base,
      rect: { x: 0, y: 0, width: 100, height: 40 },
      inert: true,
    }).visibility).toBe('intentionally-hidden');
  });

  it('distinguishes not-rendered state from intentionally collapsed state', () => {
    expect(observePageVisibility({
      ...base,
      display: 'none',
    }).visibility).toBe('not-rendered');
  });
});
