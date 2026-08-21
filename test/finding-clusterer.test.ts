import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/core/types.js';
import { clusterFindings } from '../src/findings/finding-clusterer.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'BUG-0001',
    kind: 'ui',
    severity: 'medium',
    title: 'Interactive control outside viewport',
    url: 'https://example.com/settings',
    message: 'Interactive element is unreachable or clipped by the viewport: button#menu "Menu" [viewport=mobile 390x844]',
    reproduction: ['Open page'],
    evidence: ['/run/a.png'],
    fingerprint: 'fp-1',
    truth: {
      screenshot: 'available',
      annotation: 'unverified',
      reproduction: 'confirmed',
      verdict: 'potential-product-defect',
      reasons: ['fixture'],
    },
    ...overrides,
  };
}

describe('Beta.10 FindingClusterer', () => {
  it('clusters the same shared visual component across routes/viewports while retaining every raw finding id and evidence path', () => {
    const input = [
      finding(),
      finding({
        id: 'BUG-0002',
        url: 'https://example.com/profile',
        message: 'Interactive element is unreachable or clipped by the viewport: button#menu "Menu" [viewport=tablet 768x1024]',
        evidence: ['/run/b.png'],
        fingerprint: 'fp-2',
      }),
    ];

    const clustered = clusterFindings(input);
    expect(clustered).toMatchObject({ rawFindings: 2, clusters: 1, duplicateFindings: 1 });
    expect(clustered.items[0]?.memberFindingIds).toEqual(['BUG-0001', 'BUG-0002']);
    expect(clustered.items[0]?.evidence).toEqual(['/run/a.png', '/run/b.png']);
    expect(input).toHaveLength(2);
  });

  it('does not cluster visually similar findings with different truth verdicts', () => {
    const clustered = clusterFindings([
      finding(),
      finding({
        id: 'BUG-0002',
        fingerprint: 'fp-2',
        truth: {
          screenshot: 'available',
          annotation: 'rejected',
          reproduction: 'not-reproduced',
          verdict: 'qa-engine-false-positive',
          reasons: ['fresh context did not reproduce'],
        },
      }),
    ]);
    expect(clustered.clusters).toBe(2);
    expect(clustered.duplicateFindings).toBe(0);
  });

  it('keeps document-wide layout overflow route-scoped', () => {
    const first = finding({
      title: 'Horizontal layout overflow',
      message: 'Document is horizontally overflowing by 24px [viewport=mobile 390x844]',
    });
    const second = finding({
      id: 'BUG-0002',
      fingerprint: 'fp-2',
      url: 'https://example.com/profile',
      title: 'Horizontal layout overflow',
      message: 'Document is horizontally overflowing by 28px [viewport=tablet 768x1024]',
    });
    const clustered = clusterFindings([first, second]);
    expect(clustered.clusters).toBe(2);
  });
});
