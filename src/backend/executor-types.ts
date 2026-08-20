import type { WorkItem } from '../planning/work-item.js';

export interface BackendSourceContext {
  path: string;
  sha256: string;
  content: string;
}

export interface BackendFileChange {
  operation: 'create' | 'replace';
  path: string;
  expectedSha256?: string;
  content: string;
}

export interface BackendVerificationCommand {
  program: string;
  args: string[];
}

export interface BackendTaskProposal {
  schemaVersion: 1;
  workItemId: string;
  scopeHash: string;
  proposalHash: string;
  summary: string;
  changes: BackendFileChange[];
  targetedTests: BackendVerificationCommand[];
  regression: BackendVerificationCommand;
  beta7Qa?: BackendVerificationCommand;
}

export interface BackendTaskProposalDraft extends Omit<BackendTaskProposal, 'proposalHash'> {
  proposalHash?: never;
}

export interface BackendModelContext {
  workItem: Pick<WorkItem,
    | 'id'
    | 'kind'
    | 'title'
    | 'goal'
    | 'why'
    | 'dependencies'
    | 'affectedModules'
    | 'affectedFiles'
    | 'designRequirements'
    | 'implementationPlan'
    | 'securityImpact'
    | 'risks'
    | 'acceptanceCriteria'
    | 'requiredTests'
    | 'qaStrategy'
    | 'approval'
    | 'execution'>;
  files: BackendSourceContext[];
}

export interface BackendImplementationModel {
  propose(context: BackendModelContext): Promise<BackendTaskProposalDraft>;
}

export interface BackendCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BackendExecutionWorkspace {
  currentBranch(): Promise<string>;
  isClean(): Promise<boolean>;
  collectContext(item: WorkItem, maxFiles: number): Promise<BackendSourceContext[]>;
  createBranch(itemId: string): Promise<string>;
  applyChange(change: BackendFileChange, item: WorkItem): Promise<void>;
  run(command: BackendVerificationCommand): Promise<BackendCommandResult>;
  rollback(originalBranch: string, executionBranch: string): Promise<void>;
}

export interface BackendProposalResult {
  planned: boolean;
  proposal?: BackendTaskProposal;
  error?: string;
}

export interface BackendAttemptCommandRecord {
  stage: 'targeted' | 'regression' | 'beta7';
  program: string;
  args: string[];
  exitCode: number;
}

export interface BackendExecutionAttemptRecord {
  schemaVersion: 1;
  executorVersion: 'beta8-controlled-executor-v1';
  workItemId: string;
  scopeHash: string;
  proposalHash: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  originalBranch?: string;
  executionBranch?: string;
  changedFiles: Array<{ operation: 'create' | 'replace'; path: string }>;
  commandsExecuted: BackendAttemptCommandRecord[];
  testResults: {
    targetedPassed: boolean;
    regressionPassed: boolean;
    beta7Passed: boolean;
  };
  evidenceReferences: string[];
  rollbackState: 'not-started' | 'not-needed' | 'completed';
  outcome: 'verified' | 'rejected' | 'rolled-back';
  error?: string;
}

export interface BackendExecutionResult {
  executed: boolean;
  branch?: string;
  targetedPassed: boolean;
  regressionPassed: boolean;
  beta7Passed: boolean;
  verified: boolean;
  rolledBack: boolean;
  attemptRecord: BackendExecutionAttemptRecord;
  error?: string;
}
