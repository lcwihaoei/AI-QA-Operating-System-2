import { describe, expect, it } from 'vitest';
import { UxAgent } from '../src/agents/ux-agent.js';
import type { UxPageSnapshot, UxReasoner } from '../src/ux/ux-types.js';

const snapshot: UxPageSnapshot = {
  urlPath: '/',
  routeDepth: 0,
  interactiveCount: 4,
  buttonCount: 2,
  linkCount: 2,
  formFieldCount: 0,
  unlabeledInteractiveCount: 0,
  headings: 1,
  h1Count: 1,
  primaryActionKinds: ['button'],
  ambiguousActionCount: 0,
  textChars: 300,
  scrollRatio: 1,
  navLandmarks: 1,
  hasMeaningfulTitle: true,
};

describe('UX reasoner execution status', () => {
  it('preserves a reasoner failure as explicit deterministic fallback', async () => {
    const reasoner: UxReasoner = {
      async propose() {
        throw new Error('reasoner unavailable');
      },
    };

    const result = await new UxAgent(undefined, reasoner).run(['https://example.com/'], [], [snapshot]);
    expect(result.summary.reasonerUsed).toBe(false);
    expect(result.summary.reasonerStatus).toMatchObject({
      configured: true,
      attempted: true,
      used: false,
      fallbackUsed: true,
      outcome: 'fallback',
    });
    expect(result.summary.reasonerStatus.error).toContain('reasoner unavailable');
  });

  it('reports repaired reasoner output distinctly from an ordinary successful call', async () => {
    const reasoner: UxReasoner = {
      async propose() {
        return [];
      },
      getLastExecutionMetadata() {
        return { provider: 'minimax:MiniMax-M3', repairAttempted: true };
      },
    };

    const result = await new UxAgent(undefined, reasoner).run(['https://example.com/'], [], [snapshot]);
    expect(result.summary.reasonerUsed).toBe(true);
    expect(result.summary.reasonerStatus).toMatchObject({
      configured: true,
      attempted: true,
      used: true,
      repairAttempted: true,
      fallbackUsed: false,
      outcome: 'repaired-and-used',
      provider: 'minimax:MiniMax-M3',
    });
  });

  it('reports a configured reasoner as skipped when no UX snapshot is available', async () => {
    const reasoner: UxReasoner = {
      async propose() {
        throw new Error('should not be called');
      },
    };

    const result = await new UxAgent(undefined, reasoner).run([], [], []);
    expect(result.summary.reasonerStatus).toMatchObject({
      configured: true,
      attempted: false,
      used: false,
      outcome: 'skipped',
    });
    expect(result.summary.reasonerStatus.skipReason).toContain('no successfully captured UX page snapshots');
  });
});
