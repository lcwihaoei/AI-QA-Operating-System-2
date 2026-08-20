import { createHash } from 'node:crypto';
import type { Finding, QaRunResult, Severity } from '../core/types.js';
import { assertWorkPlanSafe, type WorkExecutionPolicy, type WorkItem, type WorkPlan } from '../planning/work-item.js';

export interface Beta9SelectedFinding {
  workItemId: string;
  finding: Finding;
}

export interface Beta9Plan {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  sourceRunId: string;
  selectedFindings: Beta9SelectedFinding[];
  workPlan: WorkPlan;
}

export interface Beta9PlanValidation {
  valid: boolean;
  errors: string[];
}

const MAX_SELECTED_FINDINGS = 200;

function priorityForSeverity(severity: Severity): WorkItem['priority'] {
  if (severity === 'critical') return 'P0';
  if (severity === 'high') return 'P1';
  if (severity === 'medium') return 'P2';
  return 'P3';
}

function confidenceForFinding(finding: Finding): number {
  const evidenceBonus = Math.min(finding.evidence.length, 3) * 0.03;
  const reproductionBonus = Math.min(finding.reproduction.length, 3) * 0.02;
  return Math.min(0.98, 0.78 + evidenceBonus + reproductionBonus);
}

function workItemId(fingerprint: string): string {
  return `B9-FIX-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 14).toUpperCase()}`;
}

function moduleFromUrl(url: string): string[] {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean)[0];
    return segment ? [segment.slice(0, 100)] : ['root'];
  } catch {
    return ['unknown-route'];
  }
}

function defaultExecution(): WorkExecutionPolicy {
  return {
    mutationAllowed: false,
    allowedPaths: [],
    forbiddenPaths: ['.git/**', '.github/workflows/**', '**/.env*', '**/*secret*', '**/*credential*', '**/*.pem', '**/*.key'],
    maxAttempts: 3,
    requireCleanWorkspace: true,
    requireIsolatedBranch: true,
    requireTargetedTests: true,
    requireRegressionTests: true,
    requireBeta7Qa: true,
  };
}

function workItemFromFinding(finding: Finding): WorkItem {
  return {
    id: workItemId(finding.fingerprint),
    kind: 'bug-fix',
    title: finding.title.slice(0, 300),
    goal: `Resolve Beta.7 finding ${finding.fingerprint} without suppressing unrelated behavior.`,
    why: finding.message.slice(0, 2_000),
    source: [
      { type: 'qa-finding', reference: finding.fingerprint, note: `${finding.severity}:${finding.kind}` },
      ...finding.evidence.slice(0, 20).map((reference) => ({ type: 'source' as const, reference: reference.slice(0, 500) })),
    ],
    status: 'planned',
    priority: priorityForSeverity(finding.severity),
    confidence: confidenceForFinding(finding),
    dependencies: [],
    affectedModules: moduleFromUrl(finding.url),
    affectedFiles: [],
    designRequirements: finding.kind === 'ui'
      ? ['Preserve the existing product design system unless the approved fix explicitly requires a visual change.']
      : [],
    implementationPlan: [
      'Reproduce and diagnose the selected finding from bounded source context.',
      'Propose the smallest source change that addresses the root cause rather than hiding the symptom.',
      'Keep code mutation disabled until the user approves the concrete plan and repository-relative paths.',
    ],
    securityImpact: [
      'Do not weaken authentication, authorization, validation, browser security boundaries, logging redaction, or dependency integrity to make the finding disappear.',
    ],
    risks: [
      'A broad suppression may make the original finding disappear while introducing an undetected regression.',
      'Source mapping is advisory until the proposal is reviewed against repository evidence.',
    ],
    acceptanceCriteria: [
      `The selected finding ${finding.fingerprint} no longer reproduces under the approved scenario.`,
      'Targeted verification passes.',
      'Regression verification passes.',
      'A post-fix Beta.7 run does not silently introduce critical/high regressions.',
    ],
    requiredTests: [
      ...finding.reproduction.slice(0, 8).map((step) => `Reproduction: ${step.slice(0, 500)}`),
      'Targeted regression test for the root cause.',
      'Post-fix Beta.7 evidence-rich QA.',
    ],
    qaStrategy: [
      `Re-run the original route ${finding.url.slice(0, 1_000)}.`,
      'Run targeted tests before broader regression tests.',
      'Run Beta.7 after the change and compare new/persistent/resolved findings.',
    ],
    approval: { required: true, approved: false },
    execution: defaultExecution(),
  };
}

export function buildBeta9Plan(input: { result: QaRunResult; selectedFingerprints: string[]; project?: string }): Beta9Plan {
  const selected = [...new Set(input.selectedFingerprints.map((value) => value.trim()).filter(Boolean))];
  if (selected.length === 0) throw new Error('Beta.9 requires at least one explicitly selected finding');
  if (selected.length > MAX_SELECTED_FINDINGS) throw new Error(`Beta.9 selection exceeds ${MAX_SELECTED_FINDINGS} findings`);
  if (selected.length !== input.selectedFingerprints.length) throw new Error('Beta.9 selection contains duplicate or empty fingerprints');

  const byFingerprint = new Map(input.result.findings.map((finding) => [finding.fingerprint, finding]));
  const missing = selected.filter((fingerprint) => !byFingerprint.has(fingerprint));
  if (missing.length > 0) throw new Error(`selected finding fingerprints were not present in the QA result: ${missing.join(', ')}`);

  const selectedFindings: Beta9SelectedFinding[] = selected.map((fingerprint) => {
    const finding = byFingerprint.get(fingerprint)!;
    return { workItemId: workItemId(finding.fingerprint), finding };
  });
  const workPlan: WorkPlan = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: (input.project ?? 'Beta.9 selected findings').trim().slice(0, 200) || 'Beta.9 selected findings',
    purpose: `Beta.9 controlled auto-fix plan from QA run ${input.result.runId}`,
    items: selectedFindings.map(({ finding }) => workItemFromFinding(finding)),
  };
  assertWorkPlanSafe(workPlan);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: workPlan.project,
    sourceRunId: input.result.runId,
    selectedFindings,
    workPlan,
  };
}

export function validateBeta9Plan(plan: Beta9Plan): Beta9PlanValidation {
  const errors: string[] = [];
  try { assertWorkPlanSafe(plan.workPlan); } catch (error: unknown) { errors.push(String(error)); }
  if (plan.schemaVersion !== 1) errors.push('unsupported Beta.9 plan schema');
  if (!plan.sourceRunId?.trim()) errors.push('sourceRunId is required');
  if (plan.selectedFindings.length === 0 || plan.selectedFindings.length > MAX_SELECTED_FINDINGS) errors.push('invalid selected finding count');
  const itemIds = new Set(plan.workPlan.items.map((item) => item.id));
  const fingerprints = new Set<string>();
  for (const selected of plan.selectedFindings) {
    if (!itemIds.has(selected.workItemId)) errors.push(`selected finding has no work item: ${selected.workItemId}`);
    if (selected.workItemId !== workItemId(selected.finding.fingerprint)) errors.push(`work item id does not match finding fingerprint: ${selected.finding.fingerprint}`);
    if (fingerprints.has(selected.finding.fingerprint)) errors.push(`duplicate selected finding: ${selected.finding.fingerprint}`);
    fingerprints.add(selected.finding.fingerprint);
  }
  for (const item of plan.workPlan.items) {
    if (!plan.selectedFindings.some((selected) => selected.workItemId === item.id)) errors.push(`work item has no selected finding: ${item.id}`);
    if (item.kind !== 'bug-fix') errors.push(`Beta.9 selected finding item must be bug-fix: ${item.id}`);
  }
  return { valid: errors.length === 0, errors };
}

export function selectedFindingForItem(plan: Beta9Plan, itemId: string): Finding {
  const validation = validateBeta9Plan(plan);
  if (!validation.valid) throw new Error(`invalid Beta.9 plan: ${validation.errors.join('; ')}`);
  const selected = plan.selectedFindings.find((candidate) => candidate.workItemId === itemId);
  if (!selected) throw new Error(`unknown Beta.9 work item: ${itemId}`);
  return selected.finding;
}
