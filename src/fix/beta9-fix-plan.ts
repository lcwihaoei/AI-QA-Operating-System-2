import { createHash } from 'node:crypto';
import type { Finding } from '../core/types.js';
import { safeBackendPath, validateBackendVerificationCommand } from '../backend/backend-executor.js';
import type { BackendFileChange, BackendVerificationCommand } from '../backend/executor-types.js';
import { assertWorkPlanSafe, type WorkItem } from '../planning/work-item.js';
import type { FixSourceFile } from './fix-types.js';
import { selectedFindingForItem, type Beta9Plan } from './beta9-planner.js';

export interface Beta9FixPlanDraft {
  schemaVersion: 1;
  workItemId: string;
  findingFingerprint: string;
  summary: string;
  rootCause: string;
  recommendedChange: string[];
  regressionRisk: string[];
  confidence: number;
  changes: BackendFileChange[];
  targetedTests: BackendVerificationCommand[];
  regression: BackendVerificationCommand;
  beta7Qa: BackendVerificationCommand;
}

export interface Beta9FixPlan extends Beta9FixPlanDraft {
  planHash: string;
}

export interface Beta9FixModelContext {
  finding: Pick<Finding, 'fingerprint' | 'severity' | 'kind' | 'title' | 'url' | 'message' | 'reproduction' | 'evidence'>;
  workItem: Pick<WorkItem, 'id' | 'title' | 'goal' | 'why' | 'affectedModules' | 'designRequirements' | 'securityImpact' | 'risks' | 'acceptanceCriteria' | 'requiredTests' | 'qaStrategy'>;
  files: FixSourceFile[];
}

export interface Beta9FixPlanningModel {
  propose(context: Beta9FixModelContext): Promise<Beta9FixPlanDraft>;
}

export interface Beta9FixPlanningWorkspace {
  collectContext(finding: Finding, maxFiles: number): Promise<FixSourceFile[]>;
}

export interface Beta9FixPlanningResult {
  planned: boolean;
  plan?: Beta9FixPlan;
  error?: string;
}

const MAX_CHANGES = 8;
const MAX_CONTENT_PER_FILE = 250_000;
const MAX_TOTAL_CONTENT = 750_000;

function canonicalPlan(draft: Beta9FixPlanDraft): Beta9FixPlanDraft {
  return {
    schemaVersion: 1,
    workItemId: draft.workItemId,
    findingFingerprint: draft.findingFingerprint,
    summary: draft.summary,
    rootCause: draft.rootCause,
    recommendedChange: [...draft.recommendedChange],
    regressionRisk: [...draft.regressionRisk],
    confidence: draft.confidence,
    changes: draft.changes.map((change) => ({
      operation: change.operation,
      path: change.path,
      ...(change.expectedSha256 ? { expectedSha256: change.expectedSha256 } : {}),
      content: change.content,
    })),
    targetedTests: draft.targetedTests.map((command) => ({ program: command.program, args: [...command.args] })),
    regression: { program: draft.regression.program, args: [...draft.regression.args] },
    beta7Qa: { program: draft.beta7Qa.program, args: [...draft.beta7Qa.args] },
  };
}

export function finalizeBeta9FixPlan(draft: Beta9FixPlanDraft): Beta9FixPlan {
  const canonical = canonicalPlan(draft);
  return { ...canonical, planHash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}

export function validateBeta9FixPlan(plan: Beta9FixPlan, item: WorkItem, finding: Finding): string[] {
  const errors: string[] = [];
  if (plan.schemaVersion !== 1) errors.push('unsupported Beta.9 fix-plan schema');
  if (plan.workItemId !== item.id) errors.push('fix plan work item does not match selected task');
  if (plan.findingFingerprint !== finding.fingerprint) errors.push('fix plan finding fingerprint does not match selected finding');
  const { planHash: _planHash, ...draft } = plan;
  if (plan.planHash !== finalizeBeta9FixPlan(draft).planHash) errors.push('fix plan hash does not match plan contents');
  if (!plan.summary?.trim() || plan.summary.length > 3_000) errors.push('fix plan summary is missing or oversized');
  if (!plan.rootCause?.trim() || plan.rootCause.length > 5_000) errors.push('root cause is missing or oversized');
  if (!Array.isArray(plan.recommendedChange) || plan.recommendedChange.length < 1 || plan.recommendedChange.length > 20) errors.push('fix plan requires 1-20 recommended change steps');
  if (!Array.isArray(plan.regressionRisk) || plan.regressionRisk.length > 20) errors.push('fix plan regression risk list is invalid');
  if (!Number.isFinite(plan.confidence) || plan.confidence < 0 || plan.confidence > 1) errors.push('fix-plan confidence must be between 0 and 1');
  if (!Array.isArray(plan.changes) || plan.changes.length < 1 || plan.changes.length > MAX_CHANGES) errors.push(`fix plan must contain 1-${MAX_CHANGES} source changes`);

  const seen = new Set<string>();
  let total = 0;
  for (const change of plan.changes ?? []) {
    if (!safeBackendPath(change.path)) errors.push(`unsafe fix path: ${change.path}`);
    if (seen.has(change.path)) errors.push(`duplicate fix path: ${change.path}`);
    seen.add(change.path);
    if (!['create', 'replace'].includes(change.operation)) errors.push(`unsupported fix operation: ${change.path}`);
    if (change.operation === 'replace' && !/^[a-f0-9]{64}$/i.test(change.expectedSha256 ?? '')) errors.push(`replacement requires expected sha256: ${change.path}`);
    if (change.operation === 'create' && change.expectedSha256) errors.push(`create must not include expected sha256: ${change.path}`);
    if (typeof change.content !== 'string' || change.content.length > MAX_CONTENT_PER_FILE) errors.push(`invalid/oversized fix content: ${change.path}`);
    total += change.content?.length ?? 0;
  }
  if (total > MAX_TOTAL_CONTENT) errors.push(`fix plan content exceeds ${MAX_TOTAL_CONTENT} characters`);
  if (!Array.isArray(plan.targetedTests) || plan.targetedTests.length < 1 || plan.targetedTests.length > 8) errors.push('fix plan must include 1-8 targeted tests');
  for (const command of plan.targetedTests ?? []) {
    const error = validateBackendVerificationCommand(command);
    if (error) errors.push(`targeted test: ${error}`);
  }
  for (const [label, command] of [['regression', plan.regression], ['Beta.7 QA', plan.beta7Qa]] as const) {
    const error = validateBackendVerificationCommand(command);
    if (error) errors.push(`${label}: ${error}`);
  }
  return errors;
}

function applyPlanInsights(item: WorkItem, plan: Beta9FixPlan): void {
  if (item.approval.approved || item.execution.mutationAllowed) throw new Error('Beta.9 fix plan must be generated before repository mutation approval');
  item.affectedFiles = [...new Set(plan.changes.map((change) => change.path))].sort((a, b) => a.localeCompare(b));
  item.implementationPlan = [...plan.recommendedChange];
  item.risks = [...new Set([...item.risks, ...plan.regressionRisk])].slice(0, 30);
  item.requiredTests = [
    ...plan.targetedTests.map((command) => `${command.program} ${command.args.join(' ')}`),
    `${plan.regression.program} ${plan.regression.args.join(' ')}`,
    `${plan.beta7Qa.program} ${plan.beta7Qa.args.join(' ')}`,
  ];
  item.confidence = plan.confidence;
}

export class Beta9FixPlanner {
  constructor(private readonly model: Beta9FixPlanningModel, private readonly workspace: Beta9FixPlanningWorkspace) {}

  async plan(beta9: Beta9Plan, itemId: string, maxContextFiles = 8): Promise<Beta9FixPlanningResult> {
    try {
      assertWorkPlanSafe(beta9.workPlan);
      const finding = selectedFindingForItem(beta9, itemId);
      const item = beta9.workPlan.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error(`unknown Beta.9 work item: ${itemId}`);
      if (item.status !== 'planned' || item.approval.approved || item.execution.mutationAllowed) throw new Error('Beta.9 fix planning requires a non-approved planned work item');
      const files = await this.workspace.collectContext(finding, Math.max(1, Math.min(maxContextFiles, 12)));
      if (files.length === 0) throw new Error('no safe source context matched the selected finding');
      const draft = await this.model.propose({ finding, workItem: item, files });
      const plan = finalizeBeta9FixPlan(draft);
      const errors = validateBeta9FixPlan(plan, item, finding);
      if (errors.length > 0) throw new Error(`Beta.9 fix plan rejected: ${errors.join('; ')}`);
      applyPlanInsights(item, plan);
      assertWorkPlanSafe(beta9.workPlan);
      return { planned: true, plan };
    } catch (error: unknown) {
      return { planned: false, error: String(error) };
    }
  }
}
