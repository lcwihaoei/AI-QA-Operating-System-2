import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertWorkPlanSafe, computeWorkItemScopeHash, type WorkItem, type WorkPlan } from '../planning/work-item.js';
import type {
  BackendExecutionResult,
  BackendExecutionWorkspace,
  BackendImplementationModel,
  BackendProposalResult,
  BackendTaskProposal,
  BackendTaskProposalDraft,
  BackendVerificationCommand,
} from './executor-types.js';

const MAX_CHANGES = 12;
const MAX_FILE_CHARS = 250_000;
const MAX_TOTAL_CHARS = 800_000;
const MAX_COMMAND_ARGS = 40;
const MAX_ARG_CHARS = 500;
const SHELL_META = /[;&|><`$\n\r]/;
const DENIED_PATH = /(^|\/)(?:\.git|\.github\/workflows|\.env(?:\.|$)|secrets?|credentials?|private[-_]?keys?|id_rsa|id_ed25519|\.ssh|\.aws|\.gnupg)(\/|$)/i;
const DENIED_FILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeBackendPath(value: string): boolean {
  if (!value || value.length > 500 || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || value.split('/').includes('..')) return false;
  if (DENIED_PATH.test(value) || DENIED_FILE.test(value)) return false;
  return /^[A-Za-z0-9._/@+ -]+(?:\/[A-Za-z0-9._/@+ -]+)*$/.test(value);
}

function matchBoundedPattern(filePath: string, pattern: string): boolean {
  if (!safeBackendPath(filePath)) return false;
  if (pattern.endsWith('/**')) {
    const base = pattern.slice(0, -3).replace(/\/$/, '');
    return safeBackendPath(base) && (filePath === base || filePath.startsWith(`${base}/`));
  }
  return safeBackendPath(pattern) && filePath === pattern;
}

export function pathAllowedForWorkItem(filePath: string, item: WorkItem): boolean {
  if (!safeBackendPath(filePath)) return false;
  if (!item.execution.allowedPaths.some((pattern) => matchBoundedPattern(filePath, pattern))) return false;
  if (item.execution.forbiddenPaths.some((pattern) => {
    if (pattern === '**/.env*') return /(^|\/)\.env(?:\.|$)/i.test(filePath);
    if (pattern === '**/*secret*') return /secret/i.test(filePath);
    if (pattern === '**/*credential*') return /credential/i.test(filePath);
    if (pattern === '**/*.pem') return /\.pem$/i.test(filePath);
    if (pattern === '**/*.key') return /\.key$/i.test(filePath);
    return matchBoundedPattern(filePath, pattern);
  })) return false;
  return true;
}

export function validateBackendVerificationCommand(command: BackendVerificationCommand): string | undefined {
  if (!command || typeof command.program !== 'string' || !Array.isArray(command.args)) return 'invalid verification command';
  if (command.args.length > MAX_COMMAND_ARGS) return 'too many verification command arguments';
  for (const arg of command.args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_CHARS || SHELL_META.test(arg)) return 'unsafe verification command argument';
  }

  const [first = '', second = ''] = command.args;
  switch (command.program) {
    case 'npm':
      if (first === 'test') return undefined;
      if (first === 'run' && /^[A-Za-z0-9:_-]{1,80}$/.test(second) && /(test|check|lint|type|build|verify|qa)/i.test(second)) return undefined;
      return 'npm verification is restricted to test/check/lint/type/build/verify/qa scripts';
    case 'npx':
      return ['vitest', 'playwright', 'tsc', 'eslint'].includes(first) ? undefined : 'npx verification tool is not allowed';
    case 'pytest':
      return undefined;
    case 'python':
    case 'python3':
      return first === '-m' && second === 'pytest' ? undefined : 'python verification is restricted to -m pytest';
    case 'go':
      return ['test', 'vet'].includes(first) ? undefined : 'go verification is restricted to test/vet';
    case 'flutter':
      return ['test', 'analyze'].includes(first) ? undefined : 'flutter verification is restricted to test/analyze';
    case 'dart':
      return ['test', 'analyze'].includes(first) ? undefined : 'dart verification is restricted to test/analyze';
    case 'cargo':
      return ['test', 'check', 'clippy'].includes(first) ? undefined : 'cargo verification is restricted to test/check/clippy';
    default:
      return `verification program ${command.program} is not allowed`;
  }
}

function canonicalProposal(draft: BackendTaskProposalDraft): Omit<BackendTaskProposal, 'proposalHash'> {
  return {
    schemaVersion: 1,
    workItemId: draft.workItemId,
    scopeHash: draft.scopeHash,
    summary: draft.summary,
    changes: draft.changes.map((change) => ({
      operation: change.operation,
      path: change.path,
      ...(change.expectedSha256 ? { expectedSha256: change.expectedSha256 } : {}),
      content: change.content,
    })),
    targetedTests: draft.targetedTests.map((command) => ({ program: command.program, args: [...command.args] })),
    regression: { program: draft.regression.program, args: [...draft.regression.args] },
    ...(draft.beta7Qa ? { beta7Qa: { program: draft.beta7Qa.program, args: [...draft.beta7Qa.args] } } : {}),
  };
}

export function finalizeBackendTaskProposal(draft: BackendTaskProposalDraft): BackendTaskProposal {
  const canonical = canonicalProposal(draft);
  return { ...canonical, proposalHash: sha256(JSON.stringify(canonical)) };
}

export function validateBackendTaskProposal(proposal: BackendTaskProposal, item: WorkItem): string[] {
  const errors: string[] = [];
  if (proposal.schemaVersion !== 1) errors.push('unsupported proposal schema version');
  if (proposal.workItemId !== item.id) errors.push('proposal work item does not match approved task');
  if (!item.approval.approved || !item.approval.scopeHash) errors.push('work item is not explicitly approved');
  if (proposal.scopeHash !== item.approval.scopeHash) errors.push('proposal scope hash does not match approval');
  const { proposalHash: _proposalHash, ...draft } = proposal;
  const recomputed = finalizeBackendTaskProposal(draft).proposalHash;
  if (proposal.proposalHash !== recomputed) errors.push('proposal hash does not match proposal contents');
  if (!proposal.summary || proposal.summary.length > 3_000) errors.push('proposal summary is missing or oversized');
  if (!Array.isArray(proposal.changes) || proposal.changes.length < 1 || proposal.changes.length > MAX_CHANGES) errors.push(`proposal must contain 1-${MAX_CHANGES} file changes`);

  const seen = new Set<string>();
  let total = 0;
  for (const change of proposal.changes ?? []) {
    if (!pathAllowedForWorkItem(change.path, item)) errors.push(`change is outside approved paths: ${change.path}`);
    if (seen.has(change.path)) errors.push(`duplicate change path: ${change.path}`);
    seen.add(change.path);
    if (!['create', 'replace'].includes(change.operation)) errors.push(`unsupported change operation: ${change.path}`);
    if (change.operation === 'replace' && !/^[a-f0-9]{64}$/i.test(change.expectedSha256 ?? '')) errors.push(`replacement requires expected sha256: ${change.path}`);
    if (change.operation === 'create' && change.expectedSha256) errors.push(`create must not carry expected sha256: ${change.path}`);
    if (typeof change.content !== 'string' || change.content.length > MAX_FILE_CHARS) errors.push(`change content exceeds ${MAX_FILE_CHARS} characters: ${change.path}`);
    total += change.content?.length ?? 0;
  }
  if (total > MAX_TOTAL_CHARS) errors.push(`proposal content exceeds ${MAX_TOTAL_CHARS} characters`);

  if (!Array.isArray(proposal.targetedTests) || proposal.targetedTests.length < 1 || proposal.targetedTests.length > 8) errors.push('proposal must include 1-8 targeted tests');
  for (const command of proposal.targetedTests ?? []) {
    const error = validateBackendVerificationCommand(command);
    if (error) errors.push(error);
  }
  const regressionError = validateBackendVerificationCommand(proposal.regression);
  if (regressionError) errors.push(regressionError);
  if (proposal.beta7Qa) {
    const beta7Error = validateBackendVerificationCommand(proposal.beta7Qa);
    if (beta7Error) errors.push(beta7Error);
  }
  return errors;
}

function approvedItem(plan: WorkPlan, itemId: string): WorkItem {
  assertWorkPlanSafe(plan);
  const item = plan.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`unknown work item: ${itemId}`);
  if (item.status !== 'approved' || !item.approval.required || !item.approval.approved || !item.execution.mutationAllowed) throw new Error('work item is not approved for mutation');
  const expectedScopeHash = computeWorkItemScopeHash(item, item.execution.allowedPaths);
  if (item.approval.scopeHash !== expectedScopeHash) throw new Error('work item approval scope hash is stale or invalid');
  const incomplete = item.dependencies.filter((dependency) => plan.items.find((candidate) => candidate.id === dependency)?.status !== 'completed');
  if (incomplete.length > 0) throw new Error(`work item dependencies are not completed: ${incomplete.join(', ')}`);
  return item;
}

export class BackendTaskExecutor {
  constructor(private readonly model: BackendImplementationModel, private readonly workspace: BackendExecutionWorkspace) {}

  async propose(plan: WorkPlan, itemId: string, maxContextFiles = 8): Promise<BackendProposalResult> {
    try {
      const item = approvedItem(plan, itemId);
      const files = await this.workspace.collectContext(item, Math.max(1, Math.min(maxContextFiles, 12)));
      if (files.length === 0) throw new Error('no safe repository context was available for backend generation');
      const draft = await this.model.propose({ workItem: item, files });
      const proposal = finalizeBackendTaskProposal(draft);
      const errors = validateBackendTaskProposal(proposal, item);
      if (errors.length > 0) throw new Error(`backend proposal rejected: ${errors.join('; ')}`);
      return { planned: true, proposal };
    } catch (error: unknown) {
      return { planned: false, error: String(error) };
    }
  }

  async execute(
    plan: WorkPlan,
    itemId: string,
    proposal: BackendTaskProposal,
    input: { confirmProposalHash: string; attempt?: number; beta7Qa?: BackendVerificationCommand },
  ): Promise<BackendExecutionResult> {
    const result: BackendExecutionResult = { executed: false, targetedPassed: false, regressionPassed: false, beta7Passed: false, verified: false, rolledBack: false };
    let item: WorkItem | undefined;
    try {
      item = approvedItem(plan, itemId);
      const attempt = input.attempt ?? 1;
      if (!Number.isInteger(attempt) || attempt < 1 || attempt > item.execution.maxAttempts) throw new Error(`attempt must be between 1 and ${item.execution.maxAttempts}`);
      if (!input.confirmProposalHash || input.confirmProposalHash !== proposal.proposalHash) throw new Error('execution requires confirmation of the exact proposal hash');
      const errors = validateBackendTaskProposal(proposal, item);
      if (errors.length > 0) throw new Error(`backend proposal rejected: ${errors.join('; ')}`);
      const beta7Qa = input.beta7Qa ?? proposal.beta7Qa;
      if (item.execution.requireBeta7Qa && !beta7Qa) throw new Error('this work item requires an operator-controlled Beta.7 QA command');
      if (beta7Qa) {
        const beta7Error = validateBackendVerificationCommand(beta7Qa);
        if (beta7Error) throw new Error(beta7Error);
      }

      const originalBranch = await this.workspace.currentBranch();
      if (['main', 'master', 'trunk'].includes(originalBranch.toLowerCase())) throw new Error('execution refuses to start from a default branch; use a disposable feature branch checkout');
      if (item.execution.requireCleanWorkspace && !(await this.workspace.isClean())) throw new Error('execution requires a clean working tree');

      const branch = await this.workspace.createBranch(item.id);
      result.branch = branch;
      item.status = 'in-progress';
      try {
        for (const change of proposal.changes) await this.workspace.applyChange(change, item);
        result.executed = true;

        for (const command of proposal.targetedTests) {
          const tested = await this.workspace.run(command);
          if (tested.exitCode !== 0) throw new Error(`targeted verification failed: ${command.program} ${command.args.join(' ')}`);
        }
        result.targetedPassed = true;

        const regression = await this.workspace.run(proposal.regression);
        if (regression.exitCode !== 0) throw new Error('regression verification failed');
        result.regressionPassed = true;

        if (beta7Qa) {
          const beta7 = await this.workspace.run(beta7Qa);
          if (beta7.exitCode !== 0) throw new Error('Beta.7 QA gate failed');
          result.beta7Passed = true;
        } else {
          result.beta7Passed = !item.execution.requireBeta7Qa;
        }
        result.verified = result.targetedPassed && result.regressionPassed && result.beta7Passed;
        item.status = result.verified ? 'completed' : 'verification';
        return result;
      } catch (error: unknown) {
        await this.workspace.rollback(originalBranch, branch);
        result.rolledBack = true;
        item.status = 'blocked';
        throw error;
      }
    } catch (error: unknown) {
      result.error = String(error);
      if (item && item.status === 'in-progress') item.status = 'blocked';
      return result;
    }
  }
}
