import { assertWorkPlanSafe, computeWorkItemScopeHash, type WorkItem } from '../planning/work-item.js';
import { pathAllowedForWorkItem, validateBackendVerificationCommand } from '../backend/backend-executor.js';
import type { BackendExecutionWorkspace, BackendVerificationCommand } from '../backend/executor-types.js';
import { selectedFindingForItem, validateBeta9Plan, type Beta9Plan } from './beta9-planner.js';
import { validateBeta9FixPlan, type Beta9FixPlan } from './beta9-fix-plan.js';

export interface Beta9AttemptCommandRecord {
  stage: 'targeted' | 'regression' | 'beta7';
  program: string;
  args: string[];
  exitCode: number;
}

export interface Beta9FixAttemptRecord {
  schemaVersion: 1;
  executorVersion: 'beta9-controlled-fix-v1';
  workItemId: string;
  findingFingerprint: string;
  scopeHash: string;
  fixPlanHash: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  originalBranch?: string;
  executionBranch?: string;
  changedFiles: Array<{ operation: 'create' | 'replace'; path: string }>;
  commandsExecuted: Beta9AttemptCommandRecord[];
  testResults: { targetedPassed: boolean; regressionPassed: boolean; beta7Passed: boolean };
  evidenceReferences: string[];
  rollbackState: 'not-started' | 'not-needed' | 'completed';
  outcome: 'verified' | 'rejected' | 'rolled-back';
  error?: string;
}

export interface Beta9FixExecutionResult {
  executed: boolean;
  branch?: string;
  targetedPassed: boolean;
  regressionPassed: boolean;
  beta7Passed: boolean;
  verified: boolean;
  rolledBack: boolean;
  attemptRecord: Beta9FixAttemptRecord;
  error?: string;
}

function approvedItem(beta9: Beta9Plan, itemId: string): WorkItem {
  const beta9Validation = validateBeta9Plan(beta9);
  if (!beta9Validation.valid) throw new Error(`invalid Beta.9 plan: ${beta9Validation.errors.join('; ')}`);
  assertWorkPlanSafe(beta9.workPlan);
  const item = beta9.workPlan.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`unknown Beta.9 work item: ${itemId}`);
  if (item.kind !== 'bug-fix') throw new Error('Beta.9 executor accepts only bug-fix WorkItems');
  if (item.status !== 'approved' || !item.approval.required || !item.approval.approved || !item.execution.mutationAllowed) throw new Error('Beta.9 work item is not approved for mutation');
  const expectedScopeHash = computeWorkItemScopeHash(item, item.execution.allowedPaths);
  if (!item.approval.scopeHash || item.approval.scopeHash !== expectedScopeHash) throw new Error('Beta.9 approval scope hash is stale or invalid');
  const incomplete = item.dependencies.filter((dependency) => beta9.workPlan.items.find((candidate) => candidate.id === dependency)?.status !== 'completed');
  if (incomplete.length > 0) throw new Error(`Beta.9 work item dependencies are not completed: ${incomplete.join(', ')}`);
  return item;
}

function samePaths(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort((x, y) => x.localeCompare(y));
  const b = [...new Set(right)].sort((x, y) => x.localeCompare(y));
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function newAttempt(item: WorkItem, findingFingerprint: string, plan: Beta9FixPlan, attempt: number): Beta9FixAttemptRecord {
  const startedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    executorVersion: 'beta9-controlled-fix-v1',
    workItemId: item.id,
    findingFingerprint,
    scopeHash: item.approval.scopeHash ?? '',
    fixPlanHash: plan.planHash,
    attempt,
    startedAt,
    finishedAt: startedAt,
    changedFiles: [],
    commandsExecuted: [],
    testResults: { targetedPassed: false, regressionPassed: false, beta7Passed: false },
    evidenceReferences: [],
    rollbackState: 'not-started',
    outcome: 'rejected',
  };
}

function finishAttempt(record: Beta9FixAttemptRecord, result: Beta9FixExecutionResult): void {
  record.finishedAt = new Date().toISOString();
  record.testResults = { targetedPassed: result.targetedPassed, regressionPassed: result.regressionPassed, beta7Passed: result.beta7Passed };
}

function commandEvidence(prefix: string, command: BackendVerificationCommand): string {
  return `${prefix}:${command.program} ${command.args.join(' ')}`.slice(0, 500);
}

export class Beta9FixExecutor {
  constructor(private readonly workspace: BackendExecutionWorkspace) {}

  async execute(
    beta9: Beta9Plan,
    itemId: string,
    fixPlan: Beta9FixPlan,
    input: { confirmPlanHash: string; attempt?: number },
  ): Promise<Beta9FixExecutionResult> {
    const finding = selectedFindingForItem(beta9, itemId);
    const seedItem = beta9.workPlan.items.find((candidate) => candidate.id === itemId);
    const attemptNumber = input.attempt ?? 1;
    const placeholder = seedItem ?? ({ id: itemId, approval: { scopeHash: '' } } as WorkItem);
    const attemptRecord = newAttempt(placeholder, finding.fingerprint, fixPlan, attemptNumber);
    const result: Beta9FixExecutionResult = {
      executed: false,
      targetedPassed: false,
      regressionPassed: false,
      beta7Passed: false,
      verified: false,
      rolledBack: false,
      attemptRecord,
    };
    let item: WorkItem | undefined;
    let originalBranch: string | undefined;
    let executionBranch: string | undefined;

    try {
      item = approvedItem(beta9, itemId);
      attemptRecord.scopeHash = item.approval.scopeHash!;
      if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > item.execution.maxAttempts) throw new Error(`attempt must be between 1 and ${item.execution.maxAttempts}`);
      if (!input.confirmPlanHash || input.confirmPlanHash !== fixPlan.planHash) throw new Error('execution requires confirmation of the exact Beta.9 fix plan hash');
      const planErrors = validateBeta9FixPlan(fixPlan, item, finding);
      if (planErrors.length > 0) throw new Error(`Beta.9 fix plan rejected: ${planErrors.join('; ')}`);
      const changePaths = fixPlan.changes.map((change) => change.path);
      if (!samePaths(item.affectedFiles, changePaths)) throw new Error('approved WorkItem affectedFiles do not match the reviewed fix plan');
      for (const change of fixPlan.changes) {
        if (!pathAllowedForWorkItem(change.path, item)) throw new Error(`fix change is outside approved paths: ${change.path}`);
      }
      if (item.execution.requireTargetedTests && fixPlan.targetedTests.length === 0) throw new Error('approved WorkItem requires targeted tests');
      if (item.execution.requireRegressionTests && !fixPlan.regression) throw new Error('approved WorkItem requires regression verification');
      if (item.execution.requireBeta7Qa && !fixPlan.beta7Qa) throw new Error('approved WorkItem requires Beta.7 QA');
      for (const command of [...fixPlan.targetedTests, fixPlan.regression, fixPlan.beta7Qa]) {
        const error = validateBackendVerificationCommand(command);
        if (error) throw new Error(error);
      }

      originalBranch = await this.workspace.currentBranch();
      attemptRecord.originalBranch = originalBranch;
      if (['main', 'master', 'trunk'].includes(originalBranch.toLowerCase())) throw new Error('Beta.9 refuses to start from a default branch; use a disposable feature branch checkout');
      if (item.execution.requireCleanWorkspace && !(await this.workspace.isClean())) throw new Error('Beta.9 execution requires a clean working tree');
      executionBranch = await this.workspace.createBranch(item.id);
      result.branch = executionBranch;
      attemptRecord.executionBranch = executionBranch;
      item.status = 'in-progress';

      for (const change of fixPlan.changes) {
        await this.workspace.applyChange(change, item);
        attemptRecord.changedFiles.push({ operation: change.operation, path: change.path });
      }
      result.executed = true;

      for (const command of fixPlan.targetedTests) {
        const tested = await this.workspace.run(command);
        attemptRecord.commandsExecuted.push({ stage: 'targeted', program: command.program, args: [...command.args], exitCode: tested.exitCode });
        if (tested.exitCode !== 0) throw new Error(`Beta.9 targeted test failed: ${command.program} ${command.args.join(' ')}`);
        attemptRecord.evidenceReferences.push(commandEvidence('targeted', command));
      }
      result.targetedPassed = true;

      const regression = await this.workspace.run(fixPlan.regression);
      attemptRecord.commandsExecuted.push({ stage: 'regression', program: fixPlan.regression.program, args: [...fixPlan.regression.args], exitCode: regression.exitCode });
      if (regression.exitCode !== 0) throw new Error('Beta.9 regression gate failed');
      result.regressionPassed = true;
      attemptRecord.evidenceReferences.push(commandEvidence('regression', fixPlan.regression));

      const beta7 = await this.workspace.run(fixPlan.beta7Qa);
      attemptRecord.commandsExecuted.push({ stage: 'beta7', program: fixPlan.beta7Qa.program, args: [...fixPlan.beta7Qa.args], exitCode: beta7.exitCode });
      if (beta7.exitCode !== 0) throw new Error('Beta.9 post-fix Beta.7 QA gate failed');
      result.beta7Passed = true;
      attemptRecord.evidenceReferences.push(commandEvidence('beta7', fixPlan.beta7Qa));

      result.verified = true;
      item.status = 'completed';
      attemptRecord.rollbackState = 'not-needed';
      attemptRecord.outcome = 'verified';
      finishAttempt(attemptRecord, result);
      return result;
    } catch (error: unknown) {
      result.error = String(error);
      attemptRecord.error = result.error;
      if (item && item.status === 'in-progress' && originalBranch && executionBranch) {
        try {
          await this.workspace.rollback(originalBranch, executionBranch);
          result.rolledBack = true;
          attemptRecord.rollbackState = 'completed';
          attemptRecord.outcome = 'rolled-back';
        } catch (rollbackError: unknown) {
          result.error = `${result.error}; rollback failed: ${String(rollbackError)}`;
          attemptRecord.error = result.error;
          attemptRecord.outcome = 'rejected';
        }
        item.status = 'blocked';
      }
      finishAttempt(attemptRecord, result);
      return result;
    }
  }
}
