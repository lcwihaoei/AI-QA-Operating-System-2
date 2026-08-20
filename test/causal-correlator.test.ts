import { describe, expect, it } from 'vitest';
import { CausalCorrelator } from '../src/correlation/causal-correlator.js';
import { findingsFromEvents } from '../src/reporting/bug-reporter.js';
import type { QaEvent } from '../src/core/types.js';

const at = (ms: number) => new Date(Date.UTC(2026, 7, 19, 9, 0, 0, ms)).toISOString();

describe('Browser/network/API causal correlation', () => {
  it('builds a high-confidence chain when a browser failure matches an API assertion and UI outcome', () => {
    const browserEvents: QaEvent[] = [
      {
        timestamp: at(0),
        kind: 'action',
        url: 'https://example.com/settings',
        message: 'Click button: Save',
        details: { candidateId: 'button:3:Save', actionNumber: 4 },
      },
      {
        timestamp: at(250),
        kind: 'network',
        url: 'https://example.com/api/users/42',
        message: 'GET 500 https://example.com/api/users/42',
        details: { status: 500, method: 'GET', resourceType: 'fetch' },
      },
      {
        timestamp: at(350),
        kind: 'ui',
        url: 'https://example.com/settings',
        message: 'Horizontal overflow: scrollWidth=1200, clientWidth=390',
      },
      {
        timestamp: at(500),
        kind: 'snapshot',
        url: 'https://example.com/settings',
        message: 'Captured state after Save interaction',
        details: { candidateId: 'button:3:Save', screenshot: '/tmp/save.png' },
      },
    ];
    const apiEvents: QaEvent[] = [
      {
        timestamp: at(900),
        kind: 'assertion',
        url: 'https://example.com/api/users/42',
        message: 'API returned server error 500: GET /api/users/42',
        details: {
          api: true,
          method: 'GET',
          path: '/api/users/{id}',
          relativeUrl: '/api/users/42',
          operationId: 'getUser',
          severityHint: 'high',
          status: 500,
        },
      },
    ];

    const result = new CausalCorrelator().correlate(browserEvents, apiEvents);
    expect(result.summary).toMatchObject({ chains: 1, highConfidence: 1, apiMatched: 1, browserNetworkFailures: 1 });
    expect(result.events[0]?.details).toMatchObject({
      confidence: 'high',
      candidateId: 'button:3:Save',
      operationId: 'getUser',
      uiOutcome: 'Horizontal overflow: scrollWidth=1200, clientWidth=390',
      screenshot: '/tmp/save.png',
    });

    const findings = findingsFromEvents([...browserEvents, ...apiEvents, ...result.events]);
    const networkFinding = findings.find((finding) => finding.kind === 'network')!;
    const apiFinding = findings.find((finding) => finding.kind === 'assertion')!;
    expect(networkFinding.reproduction[0]).toContain('Click button: Save');
    expect(networkFinding.reproduction.some((step) => step.includes('UI outcome: Horizontal overflow'))).toBe(true);
    expect(networkFinding.evidence).toEqual(['/tmp/save.png']);
    expect(apiFinding.reproduction.some((step) => step.includes('GET https://example.com/api/users/42 returned 500'))).toBe(true);
    expect(apiFinding.evidence).toEqual(['/tmp/save.png']);
  });

  it('creates a medium-confidence browser/network chain without an API match', () => {
    const browserEvents: QaEvent[] = [
      { timestamp: at(0), kind: 'action', url: 'https://example.com', message: 'Click button: Load', details: { candidateId: 'load' } },
      { timestamp: at(300), kind: 'network', url: 'https://example.com/internal/data', message: 'POST 400', details: { status: 400, method: 'POST' } },
    ];
    const result = new CausalCorrelator().correlate(browserEvents, []);
    expect(result.summary).toMatchObject({ chains: 1, highConfidence: 0, apiMatched: 0 });
    expect(result.events[0]?.details?.confidence).toBe('medium');
  });

  it('does not invent causality when the nearest action is outside the time window', () => {
    const browserEvents: QaEvent[] = [
      { timestamp: at(0), kind: 'action', url: 'https://example.com', message: 'Click button: Old' },
      { timestamp: new Date(Date.UTC(2026, 7, 19, 9, 0, 5, 0)).toISOString(), kind: 'network', url: 'https://example.com/api', message: 'GET 500', details: { status: 500, method: 'GET' } },
    ];
    const result = new CausalCorrelator().correlate(browserEvents, []);
    expect(result.summary.chains).toBe(0);
    expect(result.summary.browserNetworkFailures).toBe(1);
  });
});
