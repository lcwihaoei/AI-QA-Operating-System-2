import { describe, expect, it } from 'vitest';
import { findingsFromEvents, fingerprintFinding, isToolingInteractionFailure } from '../src/reporting/bug-reporter.js';

describe('bug reporter', () => {
  it('deduplicates repeated findings by normalized fingerprint', () => {
    const first = fingerprintFinding('console', 'https://example.com/a?x=1', 'Failed item 123');
    const second = fingerprintFinding('console', 'https://example.com/a?x=9', 'Failed item 456');
    expect(first).toBe(second);
  });

  it('classifies real page errors as high severity', () => {
    const findings = findingsFromEvents([{ timestamp: new Date().toISOString(), kind: 'page-error', url: 'https://example.com', message: 'boom' }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('high');
  });

  it('keeps browser probe failures as tooling evidence instead of product findings', () => {
    const event = {
      timestamp: new Date().toISOString(),
      kind: 'page-error' as const,
      url: 'https://example.com/settings',
      message: 'Button probe failed: TimeoutError: locator.click exceeded 3000ms',
    };
    expect(isToolingInteractionFailure(event)).toBe(true);
    expect(findingsFromEvents([event])).toEqual([]);
  });

  it('keeps synthetic field failures as tooling evidence instead of product findings', () => {
    const events = [{
      timestamp: new Date().toISOString(),
      kind: 'page-error' as const,
      url: 'https://example.com/settings',
      message: 'Synthetic field fill failed: value is outside range',
    }];
    expect(findingsFromEvents(events)).toEqual([]);
  });

  it('uses bounded visual severity hints and attaches screenshot evidence', () => {
    const findings = findingsFromEvents([{
      timestamp: new Date().toISOString(),
      kind: 'ui',
      url: 'https://example.com/settings',
      message: 'Visible text appears clipped: button "Save changes"',
      details: {
        visualKind: 'text-clipping',
        severityHint: 'medium',
        screenshot: '/tmp/visual-mobile.png',
      },
    }]);
    expect(findings[0]?.severity).toBe('medium');
    expect(findings[0]?.title).toBe('Visible text is clipped');
    expect(findings[0]?.evidence).toEqual(['/tmp/visual-mobile.png']);
  });

  it('does not allow a visual event to escalate itself to high severity', () => {
    const findings = findingsFromEvents([{
      timestamp: new Date().toISOString(),
      kind: 'ui',
      url: 'https://example.com',
      message: 'visual signal',
      details: { severityHint: 'high' },
    }]);
    expect(findings[0]?.severity).toBe('low');
  });

  it('uses deterministic API assertion severity and API-specific reproduction', () => {
    const findings = findingsFromEvents([{
      timestamp: new Date().toISOString(),
      kind: 'assertion',
      url: 'https://example.com/api/users',
      message: 'API returned server error 503: GET /api/users',
      details: { api: true, severityHint: 'high', status: 503 },
    }]);
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.title).toBe('API contract or behavior violation');
    expect(findings[0]?.reproduction[0]).toContain('Send the API request');
  });
});
