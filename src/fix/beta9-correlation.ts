import { createHash } from 'node:crypto';
import type { Finding, QaRunResult } from '../core/types.js';
import type { WorkItem } from '../planning/work-item.js';
import {
  computeBeta9RetryAuthorizationHash,
  selectedFindingForItem,
  validateBeta9Plan,
  type Beta9Plan,
  type Beta9RetryAuthorization,
} from './beta9-planner.js';

export type Beta9CorrelationStatus = 'resolved' | 'persistent' | 'persistent-equivalent' | 'inconclusive';

export interface Beta9AttemptEvidence {
  schemaVersion: 1;
  workItemId: string;
  findingFingerprint: string;
  fixPlanHash: string;
  attempt: number;
  outcome: 'awaiting-correlation' | 'verified' | 'rolled-back' | 'rejected';
  originalBranch?: string;
  executionBranch?: string;
}

export interface Beta9CorrelationFindingSummary {
  fingerprint: string;
  kind: Finding['kind'];
  severity: Finding['severity'];
  title: string;
  url: string;
}

export interface Beta9CorrelationReport {
  schemaVersion: 1;
  generatedAt: string;
  workItemId: string;
  findingFingerprint: string;
  sourceRunId: string;
  postRunId: string;
  attempt: number;
  fixPlanHash: string;
  status: Beta9CorrelationStatus;
  exactFingerprintPresent: boolean;
  equivalentFinding?: Beta9CorrelationFindingSummary;
  newCriticalHigh: Beta9CorrelationFindingSummary[];
  newFindingCount: number;
  retryEligible: boolean;
  reasons: string[];
  correlationHash: string;
}

function routeKey(value: string): string {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return pathname.toLowerCase();
  } catch {
    return value.split(/[?#]/, 1)[0]!.replace(/\/+$/, '').toLowerCase();
  }
}

function titleKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function equivalentTo(selected: Finding, candidate: Finding): boolean {
  return selected.kind === candidate.kind
    && routeKey(selected.url) === routeKey(candidate.url)
    && titleKey(selected.title) === titleKey(candidate.title);
}

function summarize(finding: Finding): Beta9CorrelationFindingSummary {
  return {
    fingerprint: finding.fingerprint,
    kind: finding.kind,
    severity: finding.severity,
    title: finding.title.slice(0, 500),
    url: finding.url.slice(0, 2_000),
  };
}

function canonicalCorrelation(report: Omit<Beta9CorrelationReport, 'correlationHash' | 'generatedAt'>): string {
  return JSON.stringify({
    schemaVersion: report.schemaVersion,
    workItemId: report.workItemId,
    findingFingerprint: report.findingFingerprint,
    sourceRunId: report.sourceRunId,
    postRunId: report.postRunId,
    attempt: report.attempt,
    fixPlanHash: report.fixPlanHash,
    status: report.status,
    exactFingerprintPresent: report.exactFingerprintPresent,
    equivalentFinding: report.equivalentFinding,
    newCriticalHigh: report.newCriticalHigh,
    newFindingCount: report.newFindingCount,
    retryEligible: report.retryEligible,
    reasons: report.reasons,
  });
}

export function computeBeta9CorrelationHash(report: Omit<Beta9CorrelationReport, 'correlationHash' | 'generatedAt'>): string {
  return createHash('sha256').update(canonicalCorrelation(report)).digest('hex');
}

function itemFor(plan: Beta9Plan, itemId: string): WorkItem {
  const validation = validateBeta9Plan(plan);
  if (!validation.valid) throw new Error(`invalid Beta.9 plan: ${validation.errors.join('; ')}`);
  const item = plan.workPlan.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`unknown Beta.9 work item: ${itemId}`);
  return item;
}

export function correlateBeta9Attempt(input: {
  beta9: Beta9Plan;
  itemId: string;
  before: Pick<QaRunResult, 'runId' | 'findings'>;
  after: Pick<QaRunResult, 'runId' | 'findings'>;
  attempt: Beta9AttemptEvidence;
}): Beta9CorrelationReport {
  const { beta9, itemId, before, after, attempt } = input;
  const item = itemFor(beta9, itemId);
  const selected = selectedFindingForItem(beta9, itemId);
  if (before.runId !== beta9.sourceRunId) throw new Error(`before QA run ${before.runId} does not match Beta.9 source run ${beta9.sourceRunId}`);
  if (after.runId === before.runId) throw new Error('post-fix Beta.7 run must be a new run id');
  if (!before.findings.some((finding) => finding.fingerprint === selected.fingerprint)) throw new Error('selected finding is missing from the source Beta.7 result');
  if (attempt.schemaVersion !== 1 || attempt.workItemId !== itemId || attempt.findingFingerprint !== selected.fingerprint) throw new Error('attempt record does not match the selected Beta.9 work item');
  if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1 || attempt.attempt > item.execution.maxAttempts) throw new Error('attempt record is outside the approved attempt budget');
  if (!/^[a-f0-9]{64}$/i.test(attempt.fixPlanHash)) throw new Error('attempt record fix plan hash is invalid');

  const exact = after.findings.find((finding) => finding.fingerprint === selected.fingerprint);
  const equivalents = exact ? [] : after.findings.filter((finding) => equivalentTo(selected, finding));
  let status: Beta9CorrelationStatus;
  let equivalentFinding: Beta9CorrelationFindingSummary | undefined;
  if (exact) status = 'persistent';
  else if (equivalents.length === 1) {
    status = 'persistent-equivalent';
    equivalentFinding = summarize(equivalents[0]!);
  } else if (equivalents.length > 1) status = 'inconclusive';
  else status = 'resolved';

  const beforeFingerprints = new Set(before.findings.map((finding) => finding.fingerprint));
  const equivalentFingerprint = equivalents.length === 1 ? equivalents[0]!.fingerprint : undefined;
  const newFindings = after.findings.filter((finding) => !beforeFingerprints.has(finding.fingerprint));
  const newCriticalHigh = newFindings
    .filter((finding) => ['critical', 'high'].includes(finding.severity) && finding.fingerprint !== equivalentFingerprint)
    .map(summarize)
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));

  const reasons: string[] = [];
  if (status === 'resolved') reasons.push('Selected finding is absent from the fresh Beta.7 result and no equivalent same-kind/same-route/same-title finding was observed.');
  if (status === 'persistent') reasons.push('The exact selected finding fingerprint remains present in the fresh Beta.7 result.');
  if (status === 'persistent-equivalent') reasons.push('The exact fingerprint changed, but one same-kind/same-route/same-title finding remains; treat this conservatively as persistent.');
  if (status === 'inconclusive') reasons.push('Multiple equivalent findings match the selected finding; automatic resolution/retry classification is unsafe.');
  if (newCriticalHigh.length > 0) reasons.push(`${newCriticalHigh.length} new critical/high finding(s) appeared after the attempt; automatic retry is blocked.`);
  if (attempt.attempt >= item.execution.maxAttempts) reasons.push('The WorkItem attempt budget is exhausted.');
  if (!['awaiting-correlation', 'verified', 'rolled-back'].includes(attempt.outcome)) reasons.push(`Attempt outcome ${attempt.outcome} is not eligible for retry orchestration.`);

  const retryEligible = ['persistent', 'persistent-equivalent'].includes(status)
    && newCriticalHigh.length === 0
    && attempt.attempt < item.execution.maxAttempts
    && ['awaiting-correlation', 'verified', 'rolled-back'].includes(attempt.outcome);

  const unsigned: Omit<Beta9CorrelationReport, 'correlationHash' | 'generatedAt'> = {
    schemaVersion: 1,
    workItemId: itemId,
    findingFingerprint: selected.fingerprint,
    sourceRunId: before.runId,
    postRunId: after.runId,
    attempt: attempt.attempt,
    fixPlanHash: attempt.fixPlanHash,
    status,
    exactFingerprintPresent: Boolean(exact),
    ...(equivalentFinding ? { equivalentFinding } : {}),
    newCriticalHigh,
    newFindingCount: newFindings.length,
    retryEligible,
    reasons,
  };
  return { ...unsigned, generatedAt: new Date().toISOString(), correlationHash: computeBeta9CorrelationHash(unsigned) };
}

export function validateBeta9CorrelationReport(report: Beta9CorrelationReport): string[] {
  const errors: string[] = [];
  if (report.schemaVersion !== 1) errors.push('unsupported Beta.9 correlation schema');
  if (!report.workItemId?.trim() || !report.findingFingerprint?.trim()) errors.push('correlation work item/finding binding is missing');
  if (!report.sourceRunId?.trim() || !report.postRunId?.trim() || report.sourceRunId === report.postRunId) errors.push('correlation run ids are invalid');
  if (!Number.isInteger(report.attempt) || report.attempt < 1) errors.push('correlation attempt is invalid');
  if (!/^[a-f0-9]{64}$/i.test(report.fixPlanHash)) errors.push('correlation fix plan hash is invalid');
  if (!['resolved', 'persistent', 'persistent-equivalent', 'inconclusive'].includes(report.status)) errors.push('correlation status is invalid');
  const { correlationHash: _correlationHash, generatedAt: _generatedAt, ...unsigned } = report;
  if (report.correlationHash !== computeBeta9CorrelationHash(unsigned)) errors.push('correlation hash does not match report contents');
  return errors;
}

export function applyBeta9Correlation(beta9: Beta9Plan, report: Beta9CorrelationReport): void {
  const errors = validateBeta9CorrelationReport(report);
  if (errors.length > 0) throw new Error(`invalid Beta.9 correlation report: ${errors.join('; ')}`);
  const item = itemFor(beta9, report.workItemId);
  const selected = selectedFindingForItem(beta9, report.workItemId);
  if (report.findingFingerprint !== selected.fingerprint || report.sourceRunId !== beta9.sourceRunId) throw new Error('correlation report does not belong to this Beta.9 plan');
  item.source = [
    ...item.source.filter((entry) => entry.reference !== `beta9-correlation:${report.correlationHash}`),
    { type: 'qa-finding', reference: `beta9-correlation:${report.correlationHash}`, note: `${report.status}; postRun=${report.postRunId}` },
  ];
  if (report.status === 'resolved' && report.newCriticalHigh.length === 0) item.status = 'completed';
  else item.status = 'blocked';
}

export function prepareBeta9Retry(beta9: Beta9Plan, report: Beta9CorrelationReport): Beta9RetryAuthorization {
  const errors = validateBeta9CorrelationReport(report);
  if (errors.length > 0) throw new Error(`invalid Beta.9 correlation report: ${errors.join('; ')}`);
  const item = itemFor(beta9, report.workItemId);
  const selected = selectedFindingForItem(beta9, report.workItemId);
  if (!report.retryEligible) throw new Error('correlation report does not authorize a retry');
  if (report.findingFingerprint !== selected.fingerprint || report.sourceRunId !== beta9.sourceRunId) throw new Error('correlation report does not belong to this Beta.9 plan');
  if (report.attempt >= item.execution.maxAttempts) throw new Error('Beta.9 retry attempt budget is exhausted');

  item.status = 'planned';
  item.approval = { required: true, approved: false };
  item.execution = { ...item.execution, mutationAllowed: false, allowedPaths: [] };
  item.affectedFiles = [];
  item.implementationPlan = [
    `Retry after post-QA correlation ${report.correlationHash}.`,
    'Re-diagnose the persistent finding from fresh bounded source context; do not reuse the previous plan as approval.',
    'Generate and separately review a new fix plan, then bind a new WorkItem scope approval before mutation.',
  ];
  item.requiredTests = [
    ...selected.reproduction.slice(0, 8).map((step) => `Reproduction: ${step.slice(0, 500)}`),
    'Targeted regression test for the newly diagnosed root cause.',
    `Post-fix Beta.7 comparison against run ${report.postRunId}.`,
  ];
  item.risks = [...new Set([...item.risks, `Previous attempt ${report.attempt} did not resolve the finding according to correlation ${report.correlationHash}.`])].slice(0, 30);

  const unsigned: Omit<Beta9RetryAuthorization, 'authorizationHash'> = {
    schemaVersion: 1,
    workItemId: item.id,
    findingFingerprint: selected.fingerprint,
    previousAttempt: report.attempt,
    nextAttempt: report.attempt + 1,
    sourceRunId: beta9.sourceRunId,
    postRunId: report.postRunId,
    correlationHash: report.correlationHash,
  };
  const authorization: Beta9RetryAuthorization = { ...unsigned, authorizationHash: computeBeta9RetryAuthorizationHash(unsigned) };
  beta9.retryAuthorizations = { ...(beta9.retryAuthorizations ?? {}), [item.id]: authorization };
  return authorization;
}
