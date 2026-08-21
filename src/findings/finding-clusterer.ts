import { createHash } from 'node:crypto';
import type { Finding, Severity } from '../core/types.js';

export interface FindingCluster {
  id: string;
  key: string;
  title: string;
  verdict: string;
  severity: Severity;
  representativeFindingId: string;
  memberFindingIds: string[];
  memberFingerprints: string[];
  routes: string[];
  evidence: string[];
  duplicateCount: number;
}

export interface FindingClusterSummary {
  rawFindings: number;
  clusters: number;
  duplicateFindings: number;
  items: FindingCluster[];
}

const severityRank: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function maxSeverity(findings: Finding[]): Severity {
  return findings.reduce((best, finding) =>
    severityRank[finding.severity] > severityRank[best] ? finding.severity : best, 'info' as Severity);
}

function pathname(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url.split(/[?#]/, 1)[0] || '/';
  }
}

function normalizedMessage(finding: Finding): string {
  return finding.message
    .replace(/\s*\[viewport=[^\]]+\]\s*$/i, '')
    .replace(/\b\d+(?:\.\d+)?px\b/gi, '#px')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function visualSharedComponentCandidate(finding: Finding): boolean {
  return finding.kind === 'ui' && [
    'Interactive control outside viewport',
    'Visible text is clipped',
    'Interactive controls overlap',
  ].includes(finding.title);
}

/**
 * Cluster conservatively. Repeated element-specific visual signals may cross
 * routes because application shells/sidebar controls are commonly shared.
 * Document-wide layout findings and non-visual failures remain route-scoped so
 * unrelated pages are never merged merely because their message text resembles
 * each other.
 */
export function findingClusterKey(finding: Finding): string {
  const verdict = finding.truth?.verdict ?? 'unclassified';
  const routeScope = visualSharedComponentCandidate(finding) ? 'shared-component' : pathname(finding.url);
  const material = [finding.kind, finding.title, verdict, routeScope, normalizedMessage(finding)].join('|');
  return createHash('sha1').update(material).digest('hex').slice(0, 20);
}

export function clusterFindings(findings: Finding[]): FindingClusterSummary {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = findingClusterKey(finding);
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  const items: FindingCluster[] = [...groups.entries()].map(([key, members], index) => {
    const representative = members[0]!;
    const routes = [...new Set(members.map((finding) => pathname(finding.url)))].sort();
    const evidence = [...new Set(members.flatMap((finding) => finding.evidence))];
    return {
      id: `CLUSTER-${String(index + 1).padStart(4, '0')}`,
      key,
      title: representative.title,
      verdict: representative.truth?.verdict ?? 'unclassified',
      severity: maxSeverity(members),
      representativeFindingId: representative.id,
      memberFindingIds: members.map((finding) => finding.id),
      memberFingerprints: members.map((finding) => finding.fingerprint),
      routes,
      evidence,
      duplicateCount: Math.max(0, members.length - 1),
    };
  }).sort((a, b) => severityRank[b.severity] - severityRank[a.severity]
    || b.memberFindingIds.length - a.memberFindingIds.length
    || a.key.localeCompare(b.key));

  return {
    rawFindings: findings.length,
    clusters: items.length,
    duplicateFindings: Math.max(0, findings.length - items.length),
    items,
  };
}
