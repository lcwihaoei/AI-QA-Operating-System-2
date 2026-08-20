import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BackendBlueprint, MockMigrationItem } from './security-blueprint.js';

export type MockMigrationAction = 'retain' | 'rewire-only' | 'convert-to-seed' | 'remove-after-live-verification';
export type MockMigrationStatus = 'pending' | 'approved' | 'live-verified' | 'completed' | 'blocked';

export interface MockMigrationApproval {
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  decisionHash?: string;
}

export interface MockMigrationRecord {
  id: string;
  source: string;
  kind: MockMigrationItem['kind'];
  recommendedAction: MockMigrationAction;
  selectedAction?: MockMigrationAction;
  seedDestination?: string;
  removeSourceAfterSeed: boolean;
  destructive: boolean;
  requiresLiveVerification: boolean;
  requiresBeta7Qa: boolean;
  status: MockMigrationStatus;
  approval: MockMigrationApproval;
  liveVerificationEvidence: string[];
  completionEvidence: string[];
}

export interface MockMigrationPlan {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  records: MockMigrationRecord[];
}

export interface MockMigrationPlanValidation {
  valid: boolean;
  duplicateIds: string[];
  duplicateSources: string[];
  invalidRecords: string[];
  staleApprovals: string[];
}

const UNSAFE_SOURCE_KIND = new Set<MockMigrationItem['kind']>(['inline-mock', 'mock-library']);
const DENIED_PATH = /(^|\/)(?:\.git|\.github\/workflows|\.env(?:\.|$)|secrets?|credentials?|private[-_]?keys?|id_rsa|id_ed25519|\.ssh|\.aws|\.gnupg)(\/|$)/i;

function stableUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function safeRelativePath(value: string): boolean {
  if (!value || value.length > 500 || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || value.split('/').includes('..')) return false;
  if (DENIED_PATH.test(value)) return false;
  return /^[A-Za-z0-9._/@+ -]+(?:\/[A-Za-z0-9._/@+ -]+)*$/.test(value);
}

function recommendedAction(item: MockMigrationItem): MockMigrationAction {
  if (item.proposedAction === 'review-for-seed') return 'convert-to-seed';
  if (item.proposedAction === 'remove-after-live-qa') return UNSAFE_SOURCE_KIND.has(item.kind) ? 'rewire-only' : 'remove-after-live-verification';
  if (item.proposedAction === 'retain-until-module-qa') return 'rewire-only';
  return 'retain';
}

function recordId(item: MockMigrationItem): string {
  return `MOCK-${createHash('sha256').update(`${item.kind}\u0000${item.source}`).digest('hex').slice(0, 12).toUpperCase()}`;
}

export function computeMockMigrationDecisionHash(record: MockMigrationRecord): string {
  if (!record.selectedAction) throw new Error(`mock migration record ${record.id} has no selected action`);
  const payload = {
    version: 1,
    id: record.id,
    source: record.source,
    kind: record.kind,
    selectedAction: record.selectedAction,
    seedDestination: record.seedDestination ?? null,
    removeSourceAfterSeed: record.removeSourceAfterSeed,
    destructive: record.destructive,
    requiresLiveVerification: record.requiresLiveVerification,
    requiresBeta7Qa: record.requiresBeta7Qa,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildMockMigrationPlan(input: { project: string; items: MockMigrationItem[] }): MockMigrationPlan {
  const records = input.items.map((item): MockMigrationRecord => {
    const recommendation = recommendedAction(item);
    return {
      id: recordId(item),
      source: item.source,
      kind: item.kind,
      recommendedAction: recommendation,
      removeSourceAfterSeed: false,
      destructive: recommendation === 'remove-after-live-verification',
      requiresLiveVerification: recommendation !== 'retain',
      requiresBeta7Qa: recommendation !== 'retain',
      status: 'pending',
      approval: { approved: false },
      liveVerificationEvidence: [],
      completionEvidence: [],
    };
  });
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), project: input.project, records };
}

export function mockMigrationPlanFromBackendBlueprint(blueprint: BackendBlueprint): MockMigrationPlan {
  return buildMockMigrationPlan({ project: blueprint.projectName, items: blueprint.mockMigration });
}

export function validateMockMigrationPlan(plan: MockMigrationPlan): MockMigrationPlanValidation {
  const ids = new Set<string>();
  const sources = new Set<string>();
  const duplicateIds: string[] = [];
  const duplicateSources: string[] = [];
  const invalidRecords: string[] = [];
  const staleApprovals: string[] = [];

  for (const record of plan.records) {
    if (ids.has(record.id)) duplicateIds.push(record.id);
    ids.add(record.id);
    if (sources.has(record.source)) duplicateSources.push(record.source);
    sources.add(record.source);
    if (!safeRelativePath(record.source)) invalidRecords.push(`${record.id}:unsafe-source`);
    if (record.seedDestination && !safeRelativePath(record.seedDestination)) invalidRecords.push(`${record.id}:unsafe-seed-destination`);
    if (record.seedDestination && record.seedDestination === record.source) invalidRecords.push(`${record.id}:seed-destination-equals-source`);
    if (record.selectedAction === 'convert-to-seed' && !record.seedDestination) invalidRecords.push(`${record.id}:seed-destination-required`);
    if ((record.selectedAction === 'remove-after-live-verification' || record.removeSourceAfterSeed) && UNSAFE_SOURCE_KIND.has(record.kind)) invalidRecords.push(`${record.id}:whole-file-removal-not-allowed-for-${record.kind}`);
    if (record.status !== 'pending' && !record.approval.approved) invalidRecords.push(`${record.id}:status-requires-approval`);
    if (record.approval.approved) {
      if (!record.approval.approvedBy || !record.approval.decisionHash || !record.selectedAction) {
        invalidRecords.push(`${record.id}:incomplete-approval`);
      } else if (record.approval.decisionHash !== computeMockMigrationDecisionHash(record)) {
        staleApprovals.push(record.id);
      }
    }
    if (record.status === 'live-verified' && record.requiresLiveVerification && record.liveVerificationEvidence.length === 0) invalidRecords.push(`${record.id}:missing-live-verification-evidence`);
    if (record.status === 'completed' && record.completionEvidence.length === 0) invalidRecords.push(`${record.id}:missing-completion-evidence`);
  }

  return {
    valid: duplicateIds.length === 0 && duplicateSources.length === 0 && invalidRecords.length === 0 && staleApprovals.length === 0,
    duplicateIds: stableUnique(duplicateIds),
    duplicateSources: stableUnique(duplicateSources),
    invalidRecords: stableUnique(invalidRecords),
    staleApprovals: stableUnique(staleApprovals),
  };
}

export function approveMockMigrationRecord(
  plan: MockMigrationPlan,
  recordIdValue: string,
  input: { approvedBy: string; action: MockMigrationAction; seedDestination?: string; removeSourceAfterSeed?: boolean; decisionHash?: string },
): MockMigrationPlan {
  const record = plan.records.find((candidate) => candidate.id === recordIdValue);
  if (!record) throw new Error(`unknown mock migration record: ${recordIdValue}`);
  if (!input.approvedBy.trim()) throw new Error('mock migration approval requires approvedBy');
  if (input.action === 'convert-to-seed' && !input.seedDestination?.trim()) throw new Error('convert-to-seed requires a seed destination');
  if (input.seedDestination && !safeRelativePath(input.seedDestination.trim())) throw new Error('seed destination must be a safe repository-relative path');
  const removeSourceAfterSeed = input.action === 'convert-to-seed' ? Boolean(input.removeSourceAfterSeed) : false;
  if ((input.action === 'remove-after-live-verification' || removeSourceAfterSeed) && UNSAFE_SOURCE_KIND.has(record.kind)) {
    throw new Error(`${record.kind} cannot approve whole-file mock removal; use rewire-only and a bounded source replacement task`);
  }

  record.selectedAction = input.action;
  record.seedDestination = input.action === 'convert-to-seed' ? input.seedDestination!.trim() : undefined;
  record.removeSourceAfterSeed = removeSourceAfterSeed;
  record.destructive = input.action === 'remove-after-live-verification' || removeSourceAfterSeed;
  record.requiresLiveVerification = input.action !== 'retain';
  record.requiresBeta7Qa = input.action !== 'retain';
  record.status = 'approved';
  const decisionHash = computeMockMigrationDecisionHash(record);
  if (input.decisionHash && input.decisionHash.trim() !== decisionHash) throw new Error(`mock migration decision hash mismatch; expected ${decisionHash}`);
  record.approval = { approved: true, approvedBy: input.approvedBy.trim(), approvedAt: new Date().toISOString(), decisionHash };

  const validation = validateMockMigrationPlan(plan);
  if (!validation.valid) throw new Error(`invalid mock migration plan: ${JSON.stringify(validation)}`);
  return plan;
}

export function markMockLiveVerified(plan: MockMigrationPlan, recordIdValue: string, evidence: string[]): MockMigrationPlan {
  const record = plan.records.find((candidate) => candidate.id === recordIdValue);
  if (!record) throw new Error(`unknown mock migration record: ${recordIdValue}`);
  if (!record.approval.approved || record.status !== 'approved') throw new Error('mock migration record must be approved before live verification');
  const refs = stableUnique(evidence.map((value) => value.trim()).filter(Boolean));
  if (record.requiresLiveVerification && refs.length === 0) throw new Error('live verification evidence is required');
  record.liveVerificationEvidence = refs;
  record.status = 'live-verified';
  return plan;
}

export function markMockMigrationCompleted(plan: MockMigrationPlan, recordIdValue: string, evidence: string[]): MockMigrationPlan {
  const record = plan.records.find((candidate) => candidate.id === recordIdValue);
  if (!record) throw new Error(`unknown mock migration record: ${recordIdValue}`);
  if (!record.approval.approved) throw new Error('mock migration record must be approved before completion');
  if (record.requiresLiveVerification && record.status !== 'live-verified') throw new Error('live verification must complete before mock migration completion');
  const refs = stableUnique(evidence.map((value) => value.trim()).filter(Boolean));
  if (refs.length === 0) throw new Error('completion evidence is required');
  record.completionEvidence = refs;
  record.status = 'completed';
  return plan;
}
