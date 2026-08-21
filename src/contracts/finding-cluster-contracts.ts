export type ClusterSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface FindingCluster {
  id: string;
  key: string;
  title: string;
  verdict: string;
  severity: ClusterSeverity;
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

export function assertFindingClusterSummary(summary: FindingClusterSummary): void {
  if (summary.rawFindings < 0 || summary.clusters < 0 || summary.duplicateFindings < 0) {
    throw new Error('finding cluster counts cannot be negative');
  }
  if (summary.clusters !== summary.items.length) {
    throw new Error('finding cluster count must equal the number of cluster items');
  }
  if (summary.duplicateFindings !== Math.max(0, summary.rawFindings - summary.clusters)) {
    throw new Error('duplicate finding count must preserve raw-finding cardinality');
  }

  const memberIds = summary.items.flatMap((item) => item.memberFindingIds);
  if (memberIds.length !== summary.rawFindings) {
    throw new Error('cluster membership must preserve every raw finding exactly once');
  }
  if (new Set(memberIds).size !== memberIds.length) {
    throw new Error('a raw finding cannot belong to more than one cluster');
  }
  for (const item of summary.items) {
    if (!item.memberFindingIds.includes(item.representativeFindingId)) {
      throw new Error(`cluster ${item.id} representative must be a member`);
    }
    if (item.duplicateCount !== Math.max(0, item.memberFindingIds.length - 1)) {
      throw new Error(`cluster ${item.id} duplicateCount is inconsistent with membership`);
    }
  }
}
