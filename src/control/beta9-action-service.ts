import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { QaRunResult } from '../core/types.js';
import { LocalGitBackendWorkspace } from '../backend/local-git-backend-workspace.js';
import { pathAllowedForWorkItem } from '../backend/backend-executor.js';
import { approveWorkItem } from '../planning/work-item.js';
import { Beta9FixExecutor, type Beta9FixAttemptRecord } from '../fix/beta9-executor.js';
import {
  applyBeta9Correlation,
  correlateBeta9Attempt,
  prepareBeta9Retry,
  validateBeta9CorrelationReport,
  type Beta9AttemptEvidence,
  type Beta9CorrelationReport,
} from '../fix/beta9-correlation.js';
import { Beta9FixPlanner, validateBeta9FixPlan, type Beta9FixPlan } from '../fix/beta9-fix-plan.js';
import { validateBeta9Plan, type Beta9Plan, type Beta9RetryAuthorization } from '../fix/beta9-planner.js';
import { LocalGitFixWorkspace } from '../fix/local-git-fix-workspace.js';
import { HttpBeta9FixModel } from '../providers/http-beta9-fix-model.js';

const findingSchema = z.object({
  id: z.string(),
  kind: z.enum(['console', 'page-error', 'network', 'ui', 'navigation', 'assertion']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string(),
  url: z.string(),
  message: z.string(),
  reproduction: z.array(z.string()).max(500),
  evidence: z.array(z.string()).max(2_000),
  fingerprint: z.string(),
});
const qaResultSchema = z.object({ runId: z.string().min(1).max(500), findings: z.array(findingSchema).max(20_000) });
const MAX_JSON_BYTES = 50_000_000;

export interface Beta9DashboardActionConfig {
  planPath: string;
  sourceResultPath: string;
  repoPath?: string;
  modelEndpoint?: string;
  postResultPath?: string;
  artifactRoot?: string;
  modelToken?: string;
}

export interface Beta9DashboardFixPlanSummary {
  workItemId: string;
  attempt: number;
  planHash: string;
  summary: string;
  rootCause: string;
  recommendedChange: string[];
  regressionRisk: string[];
  confidence: number;
  changes: Array<{ operation: 'create' | 'replace'; path: string }>;
  targetedTests: string[];
  regression: string;
  beta7Qa: string;
}

interface Beta9DashboardActionItemState {
  phase?: string;
  message?: string;
  latestFixPlan?: { file: string; summary: Beta9DashboardFixPlanSummary };
  latestAttempt?: { file: string; attempt: number; outcome: string; branch?: string; error?: string };
  latestCorrelation?: { file: string; report: Pick<Beta9CorrelationReport, 'attempt' | 'status' | 'postRunId' | 'newFindingCount' | 'newCriticalHigh' | 'retryEligible' | 'reasons' | 'correlationHash'> };
  latestRetry?: { file: string; authorization: Beta9RetryAuthorization };
}

interface Beta9DashboardActionState {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, Beta9DashboardActionItemState>;
}

export interface Beta9DashboardActionSummary {
  available: boolean;
  busy: boolean;
  configuration: { repo: boolean; model: boolean; postResult: boolean };
  items: Record<string, {
    phase: string;
    message?: string;
    plan?: Beta9DashboardFixPlanSummary;
    attempt?: Beta9DashboardActionItemState['latestAttempt'];
    correlation?: Beta9DashboardActionItemState['latestCorrelation']['report'];
    retry?: Beta9RetryAuthorization;
  }>;
  error?: string;
}

function bounded(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function commandText(command: { program: string; args: string[] }): string {
  return `${command.program} ${command.args.join(' ')}`.slice(0, 1_000);
}

function safeArtifactId(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
  if (!safe) throw new Error('work item id cannot produce a safe artifact name');
  return safe;
}

function summarizeFixPlan(plan: Beta9FixPlan, attempt: number): Beta9DashboardFixPlanSummary {
  return {
    workItemId: bounded(plan.workItemId, 120),
    attempt,
    planHash: plan.planHash,
    summary: bounded(plan.summary, 3_000),
    rootCause: bounded(plan.rootCause, 5_000),
    recommendedChange: plan.recommendedChange.slice(0, 20).map((value) => bounded(value, 1_000)),
    regressionRisk: plan.regressionRisk.slice(0, 20).map((value) => bounded(value, 1_000)),
    confidence: plan.confidence,
    changes: plan.changes.map((change) => ({ operation: change.operation, path: bounded(change.path, 500) })),
    targetedTests: plan.targetedTests.map(commandText),
    regression: commandText(plan.regression),
    beta7Qa: commandText(plan.beta7Qa),
  };
}

async function readBoundedJson<T>(filePath: string): Promise<T> {
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_JSON_BYTES) throw new Error(`JSON artifact exceeds ${MAX_JSON_BYTES} bytes`);
  return JSON.parse(buffer.toString('utf8')) as T;
}

async function readPlan(filePath: string): Promise<Beta9Plan> {
  const plan = await readBoundedJson<Beta9Plan>(filePath);
  const validation = validateBeta9Plan(plan);
  if (!validation.valid) throw new Error(`invalid Beta.9 plan: ${validation.errors.join('; ')}`);
  return plan;
}

async function writePlan(filePath: string, plan: Beta9Plan): Promise<void> {
  const validation = validateBeta9Plan(plan);
  if (!validation.valid) throw new Error(`refusing to persist invalid Beta.9 plan: ${validation.errors.join('; ')}`);
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error(`immutable Beta.9 artifact already exists: ${path.basename(absolute)}`);
    throw error;
  }
}

async function readQaResult(filePath: string): Promise<Pick<QaRunResult, 'runId' | 'findings'>> {
  return qaResultSchema.parse(await readBoundedJson<unknown>(filePath)) as unknown as Pick<QaRunResult, 'runId' | 'findings'>;
}

function defaultState(): Beta9DashboardActionState {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), items: {} };
}

export class Beta9DashboardActionService {
  private busy = false;
  private readonly artifactRoot: string;
  private readonly statePath: string;

  constructor(private readonly config: Beta9DashboardActionConfig) {
    this.artifactRoot = path.resolve(config.artifactRoot ?? '.qa-beta9');
    this.statePath = path.join(this.artifactRoot, 'dashboard-action-state.json');
  }

  private async loadState(): Promise<Beta9DashboardActionState> {
    try {
      const parsed = await readBoundedJson<Beta9DashboardActionState>(this.statePath);
      if (parsed.schemaVersion !== 1 || !parsed.items || typeof parsed.items !== 'object') throw new Error('invalid Beta.9 dashboard action state');
      return parsed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return defaultState();
      throw error;
    }
  }

  private async saveState(state: Beta9DashboardActionState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await mkdir(this.artifactRoot, { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('another Beta.9 dashboard action is already running');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  private requireRepo(): string {
    if (!this.config.repoPath) throw new Error('Beta.9 target repository is not configured for dashboard actions');
    return this.config.repoPath;
  }

  private requireModel(): string {
    if (!this.config.modelEndpoint) throw new Error('Beta.9 fix-plan model endpoint is not configured for dashboard actions');
    return this.config.modelEndpoint;
  }

  private async planAndState(itemId: string): Promise<{ plan: Beta9Plan; state: Beta9DashboardActionState; itemState: Beta9DashboardActionItemState }> {
    const plan = await readPlan(this.config.planPath);
    const state = await this.loadState();
    const itemState = state.items[itemId] ?? {};
    state.items[itemId] = itemState;
    return { plan, state, itemState };
  }

  private async latestFixPlan(itemId: string, expectedHash?: string): Promise<{ plan: Beta9FixPlan; summary: Beta9DashboardFixPlanSummary }> {
    const state = await this.loadState();
    const latest = state.items[itemId]?.latestFixPlan;
    if (!latest) throw new Error('no reviewed Beta.9 fix plan is available for this work item');
    if (expectedHash && latest.summary.planHash !== expectedHash) throw new Error('requested plan hash is not the latest reviewed fix plan');
    const plan = await readBoundedJson<Beta9FixPlan>(latest.file);
    if (plan.planHash !== latest.summary.planHash) throw new Error('stored fix plan no longer matches dashboard metadata');
    return { plan, summary: latest.summary };
  }

  async summary(): Promise<Beta9DashboardActionSummary> {
    try {
      const [plan, state] = await Promise.all([readPlan(this.config.planPath), this.loadState()]);
      const items: Beta9DashboardActionSummary['items'] = {};
      for (const item of plan.workPlan.items) {
        const current = state.items[item.id] ?? {};
        items[item.id] = {
          phase: current.phase ?? item.status,
          ...(current.message ? { message: current.message } : {}),
          ...(current.latestFixPlan ? { plan: current.latestFixPlan.summary } : {}),
          ...(current.latestAttempt ? { attempt: current.latestAttempt } : {}),
          ...(current.latestCorrelation ? { correlation: current.latestCorrelation.report } : {}),
          ...(current.latestRetry ? { retry: current.latestRetry.authorization } : {}),
        };
      }
      return {
        available: true,
        busy: this.busy,
        configuration: { repo: Boolean(this.config.repoPath), model: Boolean(this.config.modelEndpoint), postResult: Boolean(this.config.postResultPath) },
        items,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {
        available: false,
        busy: this.busy,
        configuration: { repo: Boolean(this.config.repoPath), model: Boolean(this.config.modelEndpoint), postResult: Boolean(this.config.postResultPath) },
        items: {},
      };
      return {
        available: false,
        busy: this.busy,
        configuration: { repo: Boolean(this.config.repoPath), model: Boolean(this.config.modelEndpoint), postResult: Boolean(this.config.postResultPath) },
        items: {},
        error: bounded(error instanceof Error ? error.message : error, 1_000),
      };
    }
  }

  async generateFixPlan(itemId: string): Promise<Beta9DashboardActionSummary> {
    return this.mutate(async () => {
      const repo = this.requireRepo();
      const endpoint = this.requireModel();
      const { plan, state, itemState } = await this.planAndState(itemId);
      const item = plan.workPlan.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error(`unknown Beta.9 work item: ${itemId}`);
      if (item.status !== 'planned' || item.approval.approved || item.execution.mutationAllowed) throw new Error('fix-plan generation requires a non-approved planned work item');
      const attempt = plan.retryAuthorizations?.[itemId]?.nextAttempt ?? 1;
      itemState.phase = 'planning';
      itemState.message = 'Generating evidence-based bounded fix plan.';
      await this.saveState(state);
      try {
        const model = new HttpBeta9FixModel(endpoint, this.config.modelToken);
        const planner = new Beta9FixPlanner(model, new LocalGitFixWorkspace(repo));
        const result = await planner.plan(plan, itemId);
        if (!result.planned || !result.plan) throw new Error(result.error ?? 'Beta.9 fix planning failed');
        const summary = summarizeFixPlan(result.plan, attempt);
        const safe = safeArtifactId(itemId);
        const file = path.join(this.artifactRoot, 'fix-plans', `${safe}-attempt-${attempt}-${result.plan.planHash.slice(0, 12)}.json`);
        await writeImmutableJson(file, result.plan);
        await writePlan(this.config.planPath, plan);
        itemState.phase = 'planned';
        itemState.message = 'Fix plan generated. Review root cause, changes, risk and tests before approval.';
        itemState.latestFixPlan = { file, summary };
        await this.saveState(state);
        return this.summary();
      } catch (error: unknown) {
        itemState.phase = 'error';
        itemState.message = bounded(error instanceof Error ? error.message : error, 1_000);
        await this.saveState(state);
        throw error;
      }
    });
  }

  async approveFix(itemId: string, planHash: string, approvedBy: string): Promise<Beta9DashboardActionSummary> {
    return this.mutate(async () => {
      const { plan, state, itemState } = await this.planAndState(itemId);
      const item = plan.workPlan.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error(`unknown Beta.9 work item: ${itemId}`);
      const latest = await this.latestFixPlan(itemId, planHash);
      const finding = plan.selectedFindings.find((candidate) => candidate.workItemId === itemId)?.finding;
      if (!finding) throw new Error('selected finding is missing from Beta.9 plan');
      const errors = validateBeta9FixPlan(latest.plan, item, finding);
      if (errors.length > 0) throw new Error(`Beta.9 fix plan rejected: ${errors.join('; ')}`);
      const exactPaths = [...new Set(latest.plan.changes.map((change) => change.path))].sort((a, b) => a.localeCompare(b));
      approveWorkItem(plan.workPlan, itemId, { approvedBy: bounded(approvedBy, 120), allowedPaths: exactPaths });
      const approved = plan.workPlan.items.find((candidate) => candidate.id === itemId)!;
      const outside = latest.plan.changes.filter((change) => !pathAllowedForWorkItem(change.path, approved));
      if (outside.length > 0) throw new Error('exact approved path scope does not cover all reviewed changes');
      await writePlan(this.config.planPath, plan);
      itemState.phase = 'approved';
      itemState.message = `Approved exact reviewed file scope for plan ${planHash.slice(0, 12)}.`;
      await this.saveState(state);
      return this.summary();
    });
  }

  async executeFix(itemId: string, planHash: string, confirmWrite: boolean): Promise<Beta9DashboardActionSummary> {
    return this.mutate(async () => {
      if (!confirmWrite) throw new Error('dashboard execution requires explicit write confirmation');
      const repo = this.requireRepo();
      const { plan, state, itemState } = await this.planAndState(itemId);
      const latest = await this.latestFixPlan(itemId, planHash);
      const attempt = latest.summary.attempt;
      const retryAuthorizationHash = attempt > 1 ? plan.retryAuthorizations?.[itemId]?.authorizationHash : undefined;
      itemState.phase = 'executing';
      itemState.message = `Running bounded attempt ${attempt}: targeted tests, regression, then Beta.7 QA.`;
      await this.saveState(state);
      try {
        const executor = new Beta9FixExecutor(new LocalGitBackendWorkspace(repo, 'aiqa/fix'));
        const result = await executor.execute(plan, itemId, latest.plan, { confirmPlanHash: planHash, attempt, retryAuthorizationHash });
        await writePlan(this.config.planPath, plan);
        const safe = safeArtifactId(itemId);
        const file = path.join(this.artifactRoot, 'attempts', `${safe}-attempt-${attempt}-${planHash.slice(0, 12)}.json`);
        await writeImmutableJson(file, result.attemptRecord);
        itemState.latestAttempt = {
          file,
          attempt,
          outcome: result.attemptRecord.outcome,
          ...(result.branch ? { branch: result.branch } : {}),
          ...(result.error ? { error: bounded(result.error, 1_000) } : {}),
        };
        itemState.phase = result.verified ? 'awaiting-correlation' : 'blocked';
        itemState.message = result.verified
          ? 'Execution gates passed. Fresh Beta.7 result correlation is still required before completion.'
          : bounded(result.error ?? 'Execution failed and was rolled back.', 1_000);
        await this.saveState(state);
        return this.summary();
      } catch (error: unknown) {
        itemState.phase = 'error';
        itemState.message = bounded(error instanceof Error ? error.message : error, 1_000);
        await this.saveState(state);
        throw error;
      }
    });
  }

  async correlate(itemId: string): Promise<Beta9DashboardActionSummary> {
    return this.mutate(async () => {
      if (!this.config.postResultPath) throw new Error('fresh post-fix Beta.7 result is not configured for dashboard correlation');
      const { plan, state, itemState } = await this.planAndState(itemId);
      const latestAttempt = itemState.latestAttempt;
      if (!latestAttempt) throw new Error('no immutable Beta.9 attempt is available for correlation');
      const [before, after, attempt] = await Promise.all([
        readQaResult(this.config.sourceResultPath),
        readQaResult(this.config.postResultPath),
        readBoundedJson<Beta9AttemptEvidence>(latestAttempt.file),
      ]);
      const report = correlateBeta9Attempt({ beta9: plan, itemId, before, after, attempt });
      applyBeta9Correlation(plan, report);
      await writePlan(this.config.planPath, plan);
      const safe = safeArtifactId(itemId);
      const file = path.join(this.artifactRoot, 'correlations', `${safe}-attempt-${report.attempt}-${report.correlationHash.slice(0, 12)}.json`);
      await writeImmutableJson(file, report);
      itemState.latestCorrelation = {
        file,
        report: {
          attempt: report.attempt,
          status: report.status,
          postRunId: bounded(report.postRunId, 500),
          newFindingCount: report.newFindingCount,
          newCriticalHigh: report.newCriticalHigh,
          retryEligible: report.retryEligible,
          reasons: report.reasons.map((value) => bounded(value, 1_000)),
          correlationHash: report.correlationHash,
        },
      };
      itemState.phase = report.status === 'resolved' && report.newCriticalHigh.length === 0 ? 'completed' : 'correlated';
      itemState.message = report.reasons.join(' ').slice(0, 2_000);
      await this.saveState(state);
      return this.summary();
    });
  }

  async prepareRetry(itemId: string): Promise<Beta9DashboardActionSummary> {
    return this.mutate(async () => {
      const repo = this.requireRepo();
      const { plan, state, itemState } = await this.planAndState(itemId);
      if (!itemState.latestCorrelation || !itemState.latestAttempt) throw new Error('retry requires the latest immutable correlation and attempt records');
      const correlation = await readBoundedJson<Beta9CorrelationReport>(itemState.latestCorrelation.file);
      const correlationErrors = validateBeta9CorrelationReport(correlation);
      if (correlationErrors.length > 0) throw new Error(`invalid Beta.9 correlation report: ${correlationErrors.join('; ')}`);
      if (!correlation.retryEligible) throw new Error('latest Beta.9 correlation does not permit a retry');
      const attempt = await readBoundedJson<Beta9FixAttemptRecord>(itemState.latestAttempt.file);
      if (attempt.workItemId !== itemId || attempt.attempt !== correlation.attempt || attempt.fixPlanHash !== correlation.fixPlanHash) throw new Error('attempt record does not match latest correlation');
      const workspace = new LocalGitBackendWorkspace(repo, 'aiqa/fix');
      if (['awaiting-correlation', 'verified'].includes(attempt.outcome)) {
        if (!attempt.originalBranch || !attempt.executionBranch) throw new Error('successful unresolved attempt is missing branch evidence required for safe rollback');
        const current = await workspace.currentBranch();
        if (current !== attempt.executionBranch) throw new Error(`safe retry rollback requires current branch ${attempt.executionBranch}; found ${current}`);
        await workspace.rollback(attempt.originalBranch, attempt.executionBranch);
      }
      const authorization = prepareBeta9Retry(plan, correlation);
      await writePlan(this.config.planPath, plan);
      const safe = safeArtifactId(itemId);
      const file = path.join(this.artifactRoot, 'retries', `${safe}-attempt-${authorization.nextAttempt}-${authorization.authorizationHash.slice(0, 12)}.json`);
      await writeImmutableJson(file, authorization);
      itemState.phase = 'retry-ready';
      itemState.message = `Retry attempt ${authorization.nextAttempt} authorized from fresh QA evidence. A completely new fix plan and approval are required.`;
      itemState.latestRetry = { file, authorization };
      itemState.latestFixPlan = undefined;
      await this.saveState(state);
      return this.summary();
    });
  }
}
