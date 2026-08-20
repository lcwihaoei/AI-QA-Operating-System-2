import { createHash } from 'node:crypto';
import type { MockMigrationPlan, MockMigrationRecord } from './mock-migration.js';
import { computeMockMigrationDecisionHash, markMockLiveVerified, markMockMigrationCompleted, validateMockMigrationPlan } from './mock-migration.js';
import { validateBackendVerificationCommand, safeBackendPath } from './backend-executor.js';
import type { BackendCommandResult, BackendVerificationCommand } from './executor-types.js';

export interface MockMigrationSourceContext {
  path: string;
  sha256: string;
  content: string;
}

export interface MockMigrationFileChange {
  operation: 'create' | 'replace' | 'delete';
  path: string;
  expectedSha256?: string;
  content?: string;
}

export interface MockMigrationProposal {
  schemaVersion: 1;
  recordId: string;
  decisionHash: string;
  proposalHash: string;
  summary: string;
  changes: MockMigrationFileChange[];
  targetedTests: BackendVerificationCommand[];
  regression: BackendVerificationCommand;
  beta7Qa: BackendVerificationCommand;
}

export interface MockMigrationProposalDraft extends Omit<MockMigrationProposal, 'proposalHash'> {
  proposalHash?: never;
}

export interface MockMigrationModelContext {
  record: Pick<MockMigrationRecord, 'id' | 'source' | 'kind' | 'selectedAction' | 'seedDestination' | 'removeSourceAfterSeed' | 'approval' | 'liveVerificationEvidence'>;
  source: MockMigrationSourceContext;
  existingSeed?: MockMigrationSourceContext;
}

export interface MockMigrationModel {
  propose(context: MockMigrationModelContext): Promise<MockMigrationProposalDraft>;
}

export interface MockMigrationWorkspace {
  currentBranch(): Promise<string>;
  isClean(): Promise<boolean>;
  sourceContext(record: MockMigrationRecord): Promise<{ source: MockMigrationSourceContext; existingSeed?: MockMigrationSourceContext }>;
  createBranch(recordId: string): Promise<string>;
  applyChange(change: MockMigrationFileChange, record: MockMigrationRecord): Promise<void>;
  run(command: BackendVerificationCommand): Promise<BackendCommandResult>;
  rollback(originalBranch: string, executionBranch: string): Promise<void>;
}

export interface MockMigrationProposalResult {
  planned: boolean;
  proposal?: MockMigrationProposal;
  error?: string;
}

export interface MockMigrationExecutionResult {
  executed: boolean;
  branch?: string;
  targetedPassed: boolean;
  regressionPassed: boolean;
  beta7Passed: boolean;
  verified: boolean;
  rolledBack: boolean;
  evidence: string[];
  error?: string;
}

const MAX_CHANGES = 3;
const MAX_CONTENT = 300_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalProposal(draft: MockMigrationProposalDraft): Omit<MockMigrationProposal, 'proposalHash'> {
  return {
    schemaVersion: 1,
    recordId: draft.recordId,
    decisionHash: draft.decisionHash,
    summary: draft.summary,
    changes: draft.changes.map((change) => ({
      operation: change.operation,
      path: change.path,
      ...(change.expectedSha256 ? { expectedSha256: change.expectedSha256 } : {}),
      ...(typeof change.content === 'string' ? { content: change.content } : {}),
    })),
    targetedTests: draft.targetedTests.map((command) => ({ program: command.program, args: [...command.args] })),
    regression: { program: draft.regression.program, args: [...draft.regression.args] },
    beta7Qa: { program: draft.beta7Qa.program, args: [...draft.beta7Qa.args] },
  };
}

export function finalizeMockMigrationProposal(draft: MockMigrationProposalDraft): MockMigrationProposal {
  const canonical = canonicalProposal(draft);
  return { ...canonical, proposalHash: sha256(JSON.stringify(canonical)) };
}

function approvedRecordBase(plan: MockMigrationPlan, recordId: string): MockMigrationRecord {
  const validation = validateMockMigrationPlan(plan);
  if (!validation.valid) throw new Error(`invalid mock migration plan: ${JSON.stringify(validation)}`);
  const record = plan.records.find((candidate) => candidate.id === recordId);
  if (!record) throw new Error(`unknown mock migration record: ${recordId}`);
  if (!record.approval.approved || !record.approval.decisionHash || !record.selectedAction) throw new Error('mock migration record is not explicitly approved');
  if (record.approval.decisionHash !== computeMockMigrationDecisionHash(record)) throw new Error('mock migration approval is stale or invalid');
  return record;
}

function directMutationRecord(plan: MockMigrationPlan, recordId: string): MockMigrationRecord {
  const record = approvedRecordBase(plan, recordId);
  if (record.selectedAction === 'retain') throw new Error('retain decisions do not require repository mutation');
  if (record.selectedAction === 'rewire-only') throw new Error('rewire-only decisions must use the approved frontend integration WorkItem; direct mock mutation is disabled');
  if (record.requiresLiveVerification && record.status !== 'live-verified') throw new Error('live backend verification must pass before mock mutation is proposed or executed');
  return record;
}

function expectedAllowedChanges(record: MockMigrationRecord): { paths: Set<string>; sourceDeleteAllowed: boolean; seedRequired: boolean } {
  const paths = new Set<string>();
  let sourceDeleteAllowed = false;
  let seedRequired = false;
  if (record.selectedAction === 'remove-after-live-verification') {
    paths.add(record.source);
    sourceDeleteAllowed = true;
  } else if (record.selectedAction === 'convert-to-seed') {
    if (!record.seedDestination) throw new Error('convert-to-seed approval has no seed destination');
    paths.add(record.seedDestination);
    seedRequired = true;
    if (record.removeSourceAfterSeed) {
      paths.add(record.source);
      sourceDeleteAllowed = true;
    }
  }
  return { paths, sourceDeleteAllowed, seedRequired };
}

export function validateMockMigrationProposal(proposal: MockMigrationProposal, record: MockMigrationRecord): string[] {
  const errors: string[] = [];
  if (proposal.schemaVersion !== 1) errors.push('unsupported mock migration proposal schema');
  if (proposal.recordId !== record.id) errors.push('proposal record does not match approved mock migration');
  if (!record.approval.decisionHash || proposal.decisionHash !== record.approval.decisionHash) errors.push('proposal decision hash does not match approval');
  const { proposalHash: _proposalHash, ...draft } = proposal;
  if (proposal.proposalHash !== finalizeMockMigrationProposal(draft).proposalHash) errors.push('proposal hash does not match proposal contents');
  if (!proposal.summary || proposal.summary.length > 3_000) errors.push('proposal summary is missing or oversized');
  if (!Array.isArray(proposal.changes) || proposal.changes.length < 1 || proposal.changes.length > MAX_CHANGES) errors.push(`proposal must contain 1-${MAX_CHANGES} changes`);

  const allowed = expectedAllowedChanges(record);
  const seen = new Set<string>();
  let hasSeedWrite = false;
  let hasSourceDelete = false;
  for (const change of proposal.changes ?? []) {
    if (!safeBackendPath(change.path) || !allowed.paths.has(change.path)) errors.push(`mock migration change is outside approved source/destination: ${change.path}`);
    if (seen.has(change.path)) errors.push(`duplicate mock migration change: ${change.path}`);
    seen.add(change.path);
    if (change.operation === 'delete') {
      if (change.path !== record.source || !allowed.sourceDeleteAllowed) errors.push(`delete is not approved for ${change.path}`);
      if (!/^[a-f0-9]{64}$/i.test(change.expectedSha256 ?? '')) errors.push(`delete requires expected source sha256: ${change.path}`);
      if (typeof change.content === 'string') errors.push(`delete must not include content: ${change.path}`);
      if (change.path === record.source) hasSourceDelete = true;
    } else {
      if (change.path === record.source) errors.push(`source replacement is not permitted by mock migration executor: ${change.path}`);
      if (typeof change.content !== 'string' || change.content.length > MAX_CONTENT) errors.push(`invalid or oversized mock migration content: ${change.path}`);
      if (change.operation === 'replace' && !/^[a-f0-9]{64}$/i.test(change.expectedSha256 ?? '')) errors.push(`replace requires expected sha256: ${change.path}`);
      if (change.operation === 'create' && change.expectedSha256) errors.push(`create must not include expected sha256: ${change.path}`);
      if (change.path === record.seedDestination) hasSeedWrite = true;
    }
  }
  if (allowed.seedRequired && !hasSeedWrite) errors.push('convert-to-seed proposal must create or replace the approved seed destination');
  if (allowed.sourceDeleteAllowed && record.selectedAction === 'remove-after-live-verification' && !hasSourceDelete) errors.push('approved removal proposal must delete the exact mock source');
  if (record.removeSourceAfterSeed && !hasSourceDelete) errors.push('approved seed migration requires exact mock source deletion');

  if (!Array.isArray(proposal.targetedTests) || proposal.targetedTests.length < 1 || proposal.targetedTests.length > 8) errors.push('mock migration proposal must include 1-8 targeted tests');
  for (const command of proposal.targetedTests ?? []) {
    const error = validateBackendVerificationCommand(command);
    if (error) errors.push(error);
  }
  for (const [label, command] of [['regression', proposal.regression], ['Beta.7 QA', proposal.beta7Qa]] as const) {
    const error = validateBackendVerificationCommand(command);
    if (error) errors.push(`${label}: ${error}`);
  }
  return errors;
}

function commandEvidence(prefix: string, command: BackendVerificationCommand): string {
  return `${prefix}:${command.program} ${command.args.join(' ')}`.slice(0, 500);
}

export class MockMigrationExecutor {
  constructor(private readonly model: MockMigrationModel, private readonly workspace: MockMigrationWorkspace) {}

  async verifyLive(plan: MockMigrationPlan, recordId: string, command: BackendVerificationCommand): Promise<{ verified: boolean; evidence?: string; error?: string }> {
    try {
      const record = approvedRecordBase(plan, recordId);
      if (record.selectedAction === 'retain') throw new Error('retain decisions do not require live-backend verification');
      if (record.status !== 'approved') throw new Error('mock migration record must be approved before live verification');
      const commandError = validateBackendVerificationCommand(command);
      if (commandError) throw new Error(commandError);
      const result = await this.workspace.run(command);
      if (result.exitCode !== 0) throw new Error('live backend verification command failed');
      const evidence = commandEvidence('live', command);
      markMockLiveVerified(plan, recordId, [evidence]);
      return { verified: true, evidence };
    } catch (error: unknown) {
      return { verified: false, error: String(error) };
    }
  }

  async completeNoMutation(plan: MockMigrationPlan, recordId: string, beta7Qa?: BackendVerificationCommand): Promise<{ completed: boolean; evidence: string[]; error?: string }> {
    const evidence: string[] = [];
    try {
      const record = approvedRecordBase(plan, recordId);
      if (record.selectedAction === 'retain') {
        evidence.push('retain:explicitly-approved');
        markMockMigrationCompleted(plan, recordId, evidence);
        return { completed: true, evidence };
      }
      if (record.selectedAction !== 'rewire-only') throw new Error('only retain or rewire-only records can use no-mutation completion');
      if (record.status !== 'live-verified') throw new Error('rewire-only completion requires successful live verification');
      if (!beta7Qa) throw new Error('rewire-only completion requires a Beta.7 QA command');
      const error = validateBackendVerificationCommand(beta7Qa);
      if (error) throw new Error(error);
      const result = await this.workspace.run(beta7Qa);
      if (result.exitCode !== 0) throw new Error('rewire-only Beta.7 QA gate failed');
      evidence.push(...record.liveVerificationEvidence, commandEvidence('beta7', beta7Qa));
      markMockMigrationCompleted(plan, recordId, evidence);
      return { completed: true, evidence };
    } catch (error: unknown) {
      return { completed: false, evidence, error: String(error) };
    }
  }

  async propose(plan: MockMigrationPlan, recordId: string): Promise<MockMigrationProposalResult> {
    try {
      const record = directMutationRecord(plan, recordId);
      const context = await this.workspace.sourceContext(record);
      const draft = await this.model.propose({ record, ...context });
      const proposal = finalizeMockMigrationProposal(draft);
      const errors = validateMockMigrationProposal(proposal, record);
      if (errors.length > 0) throw new Error(`mock migration proposal rejected: ${errors.join('; ')}`);
      return { planned: true, proposal };
    } catch (error: unknown) {
      return { planned: false, error: String(error) };
    }
  }

  async execute(plan: MockMigrationPlan, recordId: string, proposal: MockMigrationProposal, input: { confirmProposalHash: string }): Promise<MockMigrationExecutionResult> {
    const result: MockMigrationExecutionResult = { executed: false, targetedPassed: false, regressionPassed: false, beta7Passed: false, verified: false, rolledBack: false, evidence: [] };
    let record: MockMigrationRecord | undefined;
    try {
      record = directMutationRecord(plan, recordId);
      if (input.confirmProposalHash !== proposal.proposalHash) throw new Error('execution requires confirmation of the exact mock migration proposal hash');
      const errors = validateMockMigrationProposal(proposal, record);
      if (errors.length > 0) throw new Error(`mock migration proposal rejected: ${errors.join('; ')}`);
      const originalBranch = await this.workspace.currentBranch();
      if (['main', 'master', 'trunk'].includes(originalBranch.toLowerCase())) throw new Error('mock migration refuses to start from a default branch');
      if (!(await this.workspace.isClean())) throw new Error('mock migration requires a clean working tree');

      const branch = await this.workspace.createBranch(record.id);
      result.branch = branch;
      try {
        for (const change of proposal.changes) await this.workspace.applyChange(change, record);
        result.executed = true;
        for (const command of proposal.targetedTests) {
          const tested = await this.workspace.run(command);
          if (tested.exitCode !== 0) throw new Error(`targeted mock migration verification failed: ${command.program} ${command.args.join(' ')}`);
          result.evidence.push(commandEvidence('targeted', command));
        }
        result.targetedPassed = true;
        const regression = await this.workspace.run(proposal.regression);
        if (regression.exitCode !== 0) throw new Error('mock migration regression verification failed');
        result.regressionPassed = true;
        result.evidence.push(commandEvidence('regression', proposal.regression));
        const beta7 = await this.workspace.run(proposal.beta7Qa);
        if (beta7.exitCode !== 0) throw new Error('mock migration Beta.7 QA gate failed');
        result.beta7Passed = true;
        result.evidence.push(commandEvidence('beta7', proposal.beta7Qa));
        result.verified = true;
        markMockMigrationCompleted(plan, recordId, result.evidence);
        return result;
      } catch (error: unknown) {
        await this.workspace.rollback(originalBranch, branch);
        result.rolledBack = true;
        record.status = 'blocked';
        throw error;
      }
    } catch (error: unknown) {
      result.error = String(error);
      return result;
    }
  }
}
