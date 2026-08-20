import type { BackendBlueprint } from '../backend/security-blueprint.js';

export type WorkItemKind =
  | 'feature'
  | 'bug-fix'
  | 'ux-improvement'
  | 'refactor'
  | 'security'
  | 'backend'
  | 'frontend'
  | 'database'
  | 'qa'
  | 'infrastructure';

export type WorkItemStatus =
  | 'proposed'
  | 'planned'
  | 'approved'
  | 'in-progress'
  | 'blocked'
  | 'verification'
  | 'completed'
  | 'rejected';

export interface WorkEvidence {
  type: 'qa-finding' | 'ux-opportunity' | 'frontend-discovery' | 'user-request' | 'security-review' | 'source';
  reference: string;
  note?: string;
}

export interface WorkApprovalGate {
  required: boolean;
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  scopeHash?: string;
}

export interface WorkExecutionPolicy {
  mutationAllowed: boolean;
  allowedPaths: string[];
  forbiddenPaths: string[];
  maxAttempts: number;
  requireCleanWorkspace: boolean;
  requireIsolatedBranch: boolean;
  requireTargetedTests: boolean;
  requireRegressionTests: boolean;
  requireBeta7Qa: boolean;
}

export interface WorkItem {
  id: string;
  kind: WorkItemKind;
  title: string;
  goal: string;
  why: string;
  source: WorkEvidence[];
  status: WorkItemStatus;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  confidence: number;
  dependencies: string[];
  affectedModules: string[];
  affectedFiles: string[];
  designRequirements: string[];
  implementationPlan: string[];
  securityImpact: string[];
  risks: string[];
  acceptanceCriteria: string[];
  requiredTests: string[];
  qaStrategy: string[];
  approval: WorkApprovalGate;
  execution: WorkExecutionPolicy;
}

export interface WorkPlan {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  purpose: string;
  items: WorkItem[];
}

export interface WorkPlanValidation {
  valid: boolean;
  duplicateIds: string[];
  missingDependencies: string[];
  cycles: string[][];
  invalidConfidence: string[];
  unsafeExecutionGates: string[];
}

function findCycles(items: WorkItem[]): string[][] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      const index = stack.indexOf(id);
      cycles.push(index >= 0 ? [...stack.slice(index), id] : [id, id]);
      return;
    }
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (!item) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of item.dependencies) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const item of items) visit(item.id);
  return cycles;
}

export function validateWorkPlan(plan: WorkPlan): WorkPlanValidation {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const item of plan.items) {
    if (seen.has(item.id)) duplicateIds.push(item.id);
    seen.add(item.id);
  }

  const ids = new Set(plan.items.map((item) => item.id));
  const missingDependencies = plan.items.flatMap((item) => item.dependencies
    .filter((dependency) => !ids.has(dependency))
    .map((dependency) => `${item.id}->${dependency}`));
  const invalidConfidence = plan.items.filter((item) => !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1).map((item) => item.id);
  const unsafeExecutionGates = plan.items.filter((item) => {
    if (!item.execution.mutationAllowed) return false;
    return !item.approval.required || !item.approval.approved || !item.execution.requireCleanWorkspace || !item.execution.requireIsolatedBranch;
  }).map((item) => item.id);
  const cycles = findCycles(plan.items);
  return {
    valid: duplicateIds.length === 0 && missingDependencies.length === 0 && cycles.length === 0 && invalidConfidence.length === 0 && unsafeExecutionGates.length === 0,
    duplicateIds,
    missingDependencies,
    cycles,
    invalidConfidence,
    unsafeExecutionGates,
  };
}

export function assertWorkPlanSafe(plan: WorkPlan): void {
  const validation = validateWorkPlan(plan);
  if (!validation.valid) throw new Error(`unsafe work plan: ${JSON.stringify(validation)}`);
}

function defaultExecution(requireBeta7Qa = true): WorkExecutionPolicy {
  return {
    mutationAllowed: false,
    allowedPaths: [],
    forbiddenPaths: ['.git/**', '.github/workflows/**', '**/.env*', '**/*secret*', '**/*credential*', '**/*.pem', '**/*.key'],
    maxAttempts: 3,
    requireCleanWorkspace: true,
    requireIsolatedBranch: true,
    requireTargetedTests: true,
    requireRegressionTests: true,
    requireBeta7Qa,
  };
}

export function workPlanFromBackendBlueprint(blueprint: BackendBlueprint): WorkPlan {
  const items: WorkItem[] = blueprint.tasks.map((task) => ({
    id: task.id,
    kind: task.phase === 'qa' ? 'qa' : task.phase === 'frontend-integration' ? 'frontend' : task.phase === 'data-auth' && task.module === 'persistence' ? 'database' : task.phase === 'foundation' ? 'infrastructure' : 'backend',
    title: task.title,
    goal: task.scope.join('; ') || task.title,
    why: `Required by the confirmed Beta.8 backend blueprint for ${task.module}.`,
    source: [{ type: 'frontend-discovery', reference: `backend-blueprint:${task.module}` }],
    status: 'planned',
    priority: task.phase === 'foundation' || task.phase === 'data-auth' ? 'P0' : task.phase === 'qa' ? 'P1' : 'P1',
    confidence: 1,
    dependencies: [...task.dependsOn],
    affectedModules: [task.module],
    affectedFiles: [],
    designRequirements: [],
    implementationPlan: [...task.scope],
    securityImpact: blueprint.security.controls.map((control) => control.requirement),
    risks: ['Generated implementation must remain within the explicitly approved task scope.'],
    acceptanceCriteria: [...task.acceptanceCriteria],
    requiredTests: [...task.acceptanceCriteria],
    qaStrategy: task.phase === 'qa' ? ['Run the complete Beta.7 evidence-rich QA gate.'] : ['Run targeted verification for this task before advancing dependencies.'],
    approval: { required: true, approved: false },
    execution: defaultExecution(true),
  }));

  const plan: WorkPlan = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: blueprint.projectName,
    purpose: 'Beta.8 backend implementation plan',
    items,
  };
  assertWorkPlanSafe(plan);
  return plan;
}

export function approveWorkItem(plan: WorkPlan, itemId: string, input: { approvedBy: string; scopeHash: string; allowedPaths: string[] }): WorkPlan {
  const item = plan.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`unknown work item: ${itemId}`);
  const incompleteDependencies = item.dependencies.filter((dependency) => plan.items.find((candidate) => candidate.id === dependency)?.status !== 'completed');
  if (incompleteDependencies.length > 0) throw new Error(`work item dependencies are not completed: ${incompleteDependencies.join(', ')}`);
  if (!input.approvedBy.trim() || !input.scopeHash.trim()) throw new Error('approval requires approvedBy and scopeHash');
  if (input.allowedPaths.length === 0 || input.allowedPaths.some((value) => !value.trim() || value.startsWith('/') || value.includes('..'))) throw new Error('approval requires bounded repository-relative allowed paths');

  item.status = 'approved';
  item.approval = { required: true, approved: true, approvedBy: input.approvedBy.trim(), approvedAt: new Date().toISOString(), scopeHash: input.scopeHash.trim() };
  item.execution = { ...item.execution, mutationAllowed: true, allowedPaths: [...new Set(input.allowedPaths)] };
  assertWorkPlanSafe(plan);
  return plan;
}
