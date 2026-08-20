import { describe, expect, it } from 'vitest';
import type { QaEvent } from '../src/core/types.js';
import { findingsFromEvents } from '../src/reporting/bug-reporter.js';

function event(url: string): QaEvent {
  return {
    timestamp: new Date().toISOString(),
    kind: 'ui',
    url,
    message: 'Interactive element rendered entirely outside viewport: a.navbar-brand-text "設定"',
    details: {
      browserUi: true,
      uiKind: 'interactive-offscreen',
      element: 'a.navbar-brand-text "設定"',
    },
  };
}

describe('browser shared-component finding deduplication', () => {
  it('reports one structural finding when the same component fails on many routes', () => {
    const findings = findingsFromEvents([
      event('http://localhost:5173/'),
      event('http://localhost:5173/settings/profile'),
      event('http://localhost:5173/settings/security/privacy'),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('Interactive control outside viewport');
  });

  it('keeps deterministic visual findings route-sensitive', () => {
    const makeVisual = (url: string): QaEvent => ({
      timestamp: new Date().toISOString(),
      kind: 'ui',
      url,
      message: 'Interactive element is outside or clipped by the viewport: button.save',
      details: { visual: true, visualKind: 'interactive-offscreen', viewport: 'desktop', element: 'button.save' },
    });
    expect(findingsFromEvents([makeVisual('http://example.test/a'), makeVisual('http://example.test/b')])).toHaveLength(2);
  });
});
