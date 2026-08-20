import { describe, expect, it } from 'vitest';
import {
  approveMockMigrationRecord,
  buildMockMigrationPlan,
  computeMockMigrationDecisionHash,
  markMockLiveVerified,
  markMockMigrationCompleted,
  validateMockMigrationPlan,
} from '../src/backend/mock-migration.js';
import type { MockMigrationItem } from '../src/backend/security-blueprint.js';

function item(source: string, kind: MockMigrationItem['kind'], proposedAction: MockMigrationItem['proposedAction']): MockMigrationItem {
  return { source, kind, proposedAction, destructive: proposedAction === 'remove-after-live-qa', requiresUserApproval: true };
}

describe('Beta.8 source-by-source mock migration planning', () => {
  it('creates one approval-blocked record per discovered mock source', () => {
    const plan = buildMockMigrationPlan({
      project: 'demo',
      items: [
        item('src/mocks/users.json', 'local-json', 'review-for-seed'),
        item('src/mocks/api.ts', 'mock-file', 'remove-after-live-qa'),
        item('src/pages/home.tsx', 'inline-mock', 'retain-until-module-qa'),
      ],
    });
    expect(plan.records).toHaveLength(3);
    expect(plan.records.every((record) => record.status === 'pending' && !record.approval.approved)).toBe(true);
    expect(plan.records.map((record) => record.recommendedAction)).toEqual(['convert-to-seed', 'remove-after-live-verification', 'rewire-only']);
    expect(validateMockMigrationPlan(plan).valid).toBe(true);
  });

  it('requires explicit seed destination and binds approval to a deterministic decision hash', () => {
    const plan = buildMockMigrationPlan({ project: 'demo', items: [item('src/mocks/users.json', 'local-json', 'review-for-seed')] });
    const id = plan.records[0]!.id;
    expect(() => approveMockMigrationRecord(plan, id, { approvedBy: 'owner', action: 'convert-to-seed' })).toThrow(/seed destination/);
    approveMockMigrationRecord(plan, id, { approvedBy: 'owner', action: 'convert-to-seed', seedDestination: 'backend/seeds/users.json', removeSourceAfterSeed: true });
    const record = plan.records[0]!;
    expect(record.approval.decisionHash).toBe(computeMockMigrationDecisionHash(record));
    expect(record.destructive).toBe(true);
    expect(validateMockMigrationPlan(plan).valid).toBe(true);
    record.seedDestination = 'backend/seeds/users-v2.json';
    expect(validateMockMigrationPlan(plan).staleApprovals).toEqual([id]);
  });

  it('refuses whole-file deletion for inline mocks and mock-library findings', () => {
    for (const kind of ['inline-mock', 'mock-library'] as const) {
      const plan = buildMockMigrationPlan({ project: 'demo', items: [item('src/app.tsx', kind, 'retain-until-module-qa')] });
      expect(() => approveMockMigrationRecord(plan, plan.records[0]!.id, { approvedBy: 'owner', action: 'remove-after-live-verification' })).toThrow(/cannot approve whole-file mock removal/);
    }
  });

  it('requires live verification evidence before destructive migration can complete', () => {
    const plan = buildMockMigrationPlan({ project: 'demo', items: [item('src/mocks/api.ts', 'mock-file', 'remove-after-live-qa')] });
    const id = plan.records[0]!.id;
    approveMockMigrationRecord(plan, id, { approvedBy: 'owner', action: 'remove-after-live-verification' });
    expect(() => markMockMigrationCompleted(plan, id, ['report:beta7'])).toThrow(/live verification/);
    expect(() => markMockLiveVerified(plan, id, [])).toThrow(/evidence/);
    markMockLiveVerified(plan, id, ['targeted:live-api-contract']);
    markMockMigrationCompleted(plan, id, ['beta7:run-123', 'git-diff:reviewed']);
    expect(plan.records[0]).toMatchObject({ status: 'completed', liveVerificationEvidence: ['targeted:live-api-contract'] });
    expect(validateMockMigrationPlan(plan).valid).toBe(true);
  });
});
