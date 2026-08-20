import { describe, expect, it } from 'vitest';
import { fuseVisualEvidence } from '../src/visual/evidence-fusion.js';
import type { VisualSignal } from '../src/visual/dom-geometry-analyzer.js';

const signal = (severity: 'medium' | 'low' = 'medium'): VisualSignal => ({
  kind: 'text-clipping',
  severity,
  message: 'Visible text appears clipped',
});

describe('visual evidence fusion', () => {
  it('keeps confirmed deterministic findings at their bounded severity', () => {
    const result = fuseVisualEvidence([signal()], [{ signalIndex: 0, verdict: 'confirm', confidence: 0.99 }]);
    expect(result[0]?.severity).toBe('medium');
    expect(result[0]?.assessment?.verdict).toBe('confirm');
  });

  it('downgrades but does not delete a strongly rejected geometry signal', () => {
    const result = fuseVisualEvidence([signal()], [{ signalIndex: 0, verdict: 'reject', confidence: 0.95, reason: 'intentional overlap' }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe('low');
    expect(result[0]?.assessment?.reason).toContain('intentional');
  });

  it('does not let weak rejection override deterministic severity', () => {
    const result = fuseVisualEvidence([signal()], [{ signalIndex: 0, verdict: 'reject', confidence: 0.5 }]);
    expect(result[0]?.severity).toBe('medium');
  });

  it('ignores invalid signal indexes and clamps confidence', () => {
    const result = fuseVisualEvidence([signal()], [
      { signalIndex: 99, verdict: 'reject', confidence: 1 },
      { signalIndex: 0, verdict: 'confirm', confidence: 4 },
    ]);
    expect(result[0]?.severity).toBe('medium');
    expect(result[0]?.assessment?.confidence).toBe(1);
  });
});
