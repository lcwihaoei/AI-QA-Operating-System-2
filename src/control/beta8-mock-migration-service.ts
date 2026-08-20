import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BackendVerificationCommand } from '../backend/executor-types.js';
import { LocalGitMockMigrationWorkspace } from '../backend/local-git-mock-migration-workspace.js';
import {
  MockMigrationExecutor,
  type MockMigrationModel,
  type MockMigrationProposal,
} from '../backend/mock-migration-executor.js';
import {
  approveMockMigrationRecord,
  validateMockMigrationPlan,
  type MockMigrationAction,
  type MockMigrationPlan,
  type MockMigrationRecord,
} from '../backend/mock-migration.js';
import type { WorkPlan } from '../planning/work-item.js';
import { HttpMockMigrationModel } from '../providers/http-mock-migration-model.js';

const MAX_JSON_BYTES = 50_000_000;

interface MockDashboardItemState {
  phase?: 'approved' | 'live-verifying' | 'live-verified' | 'planning' | 'proposal-ready' | 'executing' | 'completed' | 'blocked' | 'error';
  message?: string;
  latestProposal?: {
    file: string;
    summary: {
      proposalHash: string;
      decisionHash: string;
      summary: string;
      changes: Array<{ operation: 'create' | 'replace' | 'delete'; path: string }>;
      targetedTests: string[];
      regression: string;
      beta7Qa: string;
    };
  };
  latestExecution?: {
    file: string;
    branch?: string;
    verified: boolean;
    rolledBack: boolean;
    error?: string;
  };
}

interface MockDashboardState {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, MockDashboardItemState>;
}

export interface Beta8MockMigrationConfig {
  repoPath?: string;
  artifactRoot?: string;
  modelEndpoint?: string;
  modelToken?: string;
}

export interface Beta8MockMigrationSummary {
  available: boolean;
  configuration: { repo: boolean; model: boolean };
  validation?: ReturnType<typeof validateMockMigrationPlan>;
  records: Array<{
    id: string;
    source: string;
    kind: string;
    recommendedAction: MockMigrationAction;
    selectedAction?: MockMigrationAction;
    seedDestination?: string;
    removeSourceAfterSeed: boolean;
    destructive: boolean;
    requiresLiveVerification: boolean;
    requiresBeta7Qa: boolean;
    status: string;
    approved: boolean;
    approvedBy?: string;
    decisionHash?: string;
    liveVerificationEvidence: string[];
    completionEvidence: string[];
    action?: MockDashboardItemState;
  }>;
  error?: string;
}

function bounded(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function safeArtifactId(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
  if (!safe) throw new Error('mock migration id cannot produce a safe artifact name');
  return safe;
}

function commandText(command: BackendVerificationCommand): string {
  return `${command.program} ${command.args.join(' ')}`.slice(0, 1_000);
}

async function readBoundedJson<T>(filePath: string): Promise<T> {
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_JSON_BYTES) throw new Error('Beta.8 mock migration artifact exceeds size limit');
  return JSON.parse(buffer.toString('utf8')) as T;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(path.resolve(filePath), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error(`immutable Beta.8 mock artifact already exists: ${path.basename(absolute)}`);
    throw error;
  }
}

const unusedModel: MockMigrationModel = {
  async propose(): Promise<never> { throw new Error('model is not used for this mock migration action'); },
};

export class Beta8MockMigrationDashboardService {
  private busy = false;
  private readonly artifactRoot: string;
  private readonly planPath: string;
  private readonly workPlanPath: string;
  private readonly statePath: string;

  constructor(private readonly config: Beta8MockMigrationConfig) {
    this.artifactRoot = path.resolve(config.artifactRoot ?? '.qa-backend');
    this.planPath = path.join(this.artifactRoot, 'mock-migration-plan.json');
    this.workPlanPath = path.join(this.artifactRoot, 'work-plan.json');
    this.statePath = path.join(this.artifactRoot, 'dashboard-mock-state.json');
  }

  private requireRepo(): string {
    if (!this.config.repoPath) throw new Error('Beta.8 target repository is not configured for mock migration');
    return this.config.repoPath;
  }

  private requireModelEndpoint(): string {
    if (!this.config.modelEndpoint) throw new Error('Beta.8 mock migration model endpoint is not configured');
    return this.config.modelEndpoint;
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('another Beta.8 mock migration action is already running');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  private async state(): Promise<MockDashboardState> {
    try {
      const state = await readBoundedJson<MockDashboardState>(this.statePath);
      if (state.schemaVersion !== 1 || !state.items || typeof state.items !== 'object') throw new Error('invalid Beta.8 mock dashboard state');
      return state;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { schemaVersion: 1, updatedAt: new Date().toISOString(), items: {} };
      throw error;
    }
  }

  private async saveState(state: MockDashboardState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await writePrivateJson(this.statePath, state);
  }

  private async plan(): Promise<MockMigrationPlan> {
    const plan = await readBoundedJson<MockMigrationPlan>(this.planPath);
    const validation = validateMockMigrationPlan(plan);
    if (!validation.valid) throw new Error(`invalid Beta.8 mock migration plan: ${JSON.stringify(validation)}`);
    return plan;
  }

  private record(plan: MockMigrationPlan, recordId: string): MockMigrationRecord {
    const record = plan.records.find((candidate) => candidate.id === recordId);
    if (!record) throw new Error(`unknown Beta.8 mock migration record: ${recordId}`);
    return record;
  }

  private async assertFrontendIntegrationReadyForRewire(): Promise<void> {
    let workPlan: WorkPlan;
    try {
      workPlan = await readBoundedJson<WorkPlan>(this.workPlanPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error('rewire-only completion requires the Beta.8 Work Plan');
      throw error;
    }
    const integration = workPlan.items.find((item) => item.id === 'B8-INT-001');
    if (integration && integration.status !== 'completed') {
      throw new Error('rewire-only completion requires the frontend live-backend integration task B8-INT-001 to be completed first');
    }
  }

  async summary(): Promise<Beta8MockMigrationSummary> {
    try {
      const plan = await this.plan();
      const state = await this.state();
      return {
        available: true,
        configuration: { repo: Boolean(this.config.repoPath), model: Boolean(this.config.modelEndpoint) },
        validation: validateMockMigrationPlan(plan),
        records: plan.records.slice(0, 1_000).map((record) => ({
          id: record.id,
          source: bounded(record.source, 500),
          kind: record.kind,
          recommendedAction: record.recommendedAction,
          ...(record.selectedAction ? { selectedAction: record.selectedAction } : {}),
          ...(record.seedDestination ? { seedDestination: bounded(record.seedDestination, 500) } : {}),
          removeSourceAfterSeed: record.removeSourceAfterSeed,
          destructive: record.destructive,
          requiresLiveVerification: record.requiresLiveVerification,
          requiresBeta7Qa: record.requiresBeta7Qa,
          status: record.status,
          approved: record.approval.approved,
          ...(record.approval.approvedBy ? { approvedBy: bounded(record.approval.approvedBy, 120) } : {}),
          ...(record.approval.decisionHash ? { decisionHash: record.approval.decisionHash } : {}),
          liveVerificationEvidence: record.liveVerificationEvidence.map((value) => bounded(value, 500)),
          completionEvidence: record.completionEvidence.map((value) => bounded(value, 500)),
          ...(state.items[record.id] ? { action: state.items[record.id] } : {}),
        })),
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { available: false, configuration: { repo: Boolean(this.config.repoPath), model: Boolean(this.config.modelEndpoint) }, records: [] };
      }
      return {
        available: false,
        configuration: { repo: Boolean(this.config.repoPath), model: Boolean(this.config.modelEndpoint) },
        records: [],
        error: bounded(error instanceof Error ? error.message : error, 1_000),
      };
    }
  }

  async approve(input: {
    recordId: string;
    approvedBy: string;
    action: MockMigrationAction;
    seedDestination?: string;
    removeSourceAfterSeed?: boolean;
  }): Promise<Beta8MockMigrationSummary> {
    return this.mutate(async () => {
      const plan = await this.plan();
      const current = this.record(plan, input.recordId);
      if (!['pending', 'blocked'].includes(current.status)) throw new Error(`mock migration record cannot be re-approved from status ${current.status}`);
      approveMockMigrationRecord(plan, input.recordId, {
        approvedBy: bounded(input.approvedBy, 120),
        action: input.action,
        ...(input.seedDestination ? { seedDestination: input.seedDestination } : {}),
        removeSourceAfterSeed: Boolean(input.removeSourceAfterSeed),
      });
      await writePrivateJson(this.planPath, plan);
      const state = await this.state();
      state.items[input.recordId] = {
        phase: 'approved',
        message: input.action === 'retain'
          ? 'Retain decision approved. It can now be completed without repository mutation.'
          : 'Per-source mock decision approved. Live-backend verification is required before migration can continue.',
      };
      await this.saveState(state);
      return this.summary();
    });
  }

  async verifyLive(recordId: string, command: BackendVerificationCommand): Promise<Beta8MockMigrationSummary> {
    return this.mutate(async () => {
      const repo = this.requireRepo();
      const plan = await this.plan();
      const state = await this.state();
      const item = state.items[recordId] ?? {};
      state.items[recordId] = item;
      item.phase = 'live-verifying';
      item.message = 'Running the operator-reviewed live-backend verification command before mock migration.';
      await this.saveState(state);
      const executor = new MockMigrationExecutor(unusedModel, new LocalGitMockMigrationWorkspace(repo));
      const result = await executor.verifyLive(plan, recordId, command);
      if (!result.verified) {
        item.phase = 'error';
        item.message = bounded(result.error ?? 'Live-backend verification failed.', 1_000);
        await this.saveState(state);
        throw new Error(result.error ?? 'Live-backend verification failed');
      }
      await writePrivateJson(this.planPath, plan);
      item.phase = 'live-verified';
      item.message = `Live backend verified: ${bounded(result.evidence, 500)}`;
      await this.saveState(state);
      return this.summary();
    });
  }

  async completeNoMutation(recordId: string, beta7Qa?: BackendVerificationCommand): Promise<Beta8MockMigrationSummary> {
    return this.mutate(async () => {
      const repo = this.requireRepo();
      const plan = await this.plan();
      const record = this.record(plan, recordId);
      if (record.selectedAction === 'rewire-only') await this.assertFrontendIntegrationReadyForRewire();
      const executor = new MockMigrationExecutor(unusedModel, new LocalGitMockMigrationWorkspace(repo));
      const result = await executor.completeNoMutation(plan, recordId, beta7Qa);
      const state = await this.state();
      const item = state.items[recordId] ?? {};
      state.items[recordId] = item;
      if (!result.completed) {
        item.phase = 'error';
        item.message = bounded(result.error ?? 'Mock migration completion failed.', 1_000);
        await this.saveState(state);
        throw new Error(result.error ?? 'Mock migration completion failed');
      }
      await writePrivateJson(this.planPath, plan);
      item.phase = 'completed';
      item.message = record.selectedAction === 'retain'
        ? 'Mock source retained by explicit approved decision.'
        : 'Frontend rewire decision completed after live verification and Beta.7 QA.';
      await this.saveState(state);
      return this.summary();
    });
  }

  async propose(recordId: string): Promise<Beta8MockMigrationSummary> {
    return this.mutate(async () => {
      const repo = this.requireRepo();
      const endpoint = this.requireModelEndpoint();
      const plan = await this.plan();
      const state = await this.state();
      const item = state.items[recordId] ?? {};
      state.items[recordId] = item;
      item.phase = 'planning';
      item.message = 'Generating a bounded per-source mock migration proposal from the exact approved decision.';
      await this.saveState(state);
      try {
        const executor = new MockMigrationExecutor(
          new HttpMockMigrationModel(endpoint, this.config.modelToken),
          new LocalGitMockMigrationWorkspace(repo),
        );
        const result = await executor.propose(plan, recordId);
        if (!result.planned || !result.proposal) throw new Error(result.error ?? 'Mock migration proposal generation failed');
        const proposal = result.proposal;
        const safe = safeArtifactId(recordId);
        const file = path.join(this.artifactRoot, 'mock-proposals', `${safe}-${proposal.proposalHash.slice(0, 12)}.json`);
        await writeImmutableJson(file, proposal);
        item.phase = 'proposal-ready';
        item.message = 'Mock migration proposal generated. Review the exact source/seed changes and verification commands before execution.';
        item.latestProposal = {
          file,
          summary: {
            proposalHash: proposal.proposalHash,
            decisionHash: proposal.decisionHash,
            summary: bounded(proposal.summary, 3_000),
            changes: proposal.changes.map((change) => ({ operation: change.operation, path: bounded(change.path, 500) })),
            targetedTests: proposal.targetedTests.map(commandText),
            regression: commandText(proposal.regression),
            beta7Qa: commandText(proposal.beta7Qa),
          },
        };
        await this.saveState(state);
        return this.summary();
      } catch (error: unknown) {
        item.phase = 'error';
        item.message = bounded(error instanceof Error ? error.message : error, 1_000);
        await this.saveState(state);
        throw error;
      }
    });
  }

  async execute(recordId: string, proposalHash: string, confirmWrite: boolean): Promise<Beta8MockMigrationSummary> {
    return this.mutate(async () => {
      if (!confirmWrite) throw new Error('mock migration execution requires explicit write confirmation');
      const repo = this.requireRepo();
      const plan = await this.plan();
      const state = await this.state();
      const item = state.items[recordId];
      const latest = item?.latestProposal;
      if (!latest) throw new Error('no reviewed mock migration proposal is available');
      if (latest.summary.proposalHash !== proposalHash) throw new Error('requested mock proposal hash is not the latest reviewed proposal');
      const proposal = await readBoundedJson<MockMigrationProposal>(latest.file);
      if (proposal.proposalHash !== proposalHash) throw new Error('stored mock proposal no longer matches dashboard metadata');
      item.phase = 'executing';
      item.message = 'Applying the exact reviewed mock migration on an isolated branch, then running targeted, regression and Beta.7 gates.';
      await this.saveState(state);

      const executor = new MockMigrationExecutor(unusedModel, new LocalGitMockMigrationWorkspace(repo));
      const result = await executor.execute(plan, recordId, proposal, { confirmProposalHash: proposalHash });
      await writePrivateJson(this.planPath, plan);
      const safe = safeArtifactId(recordId);
      const execution = {
        schemaVersion: 1 as const,
        recordId,
        proposalHash,
        executedAt: new Date().toISOString(),
        branch: result.branch,
        executed: result.executed,
        targetedPassed: result.targetedPassed,
        regressionPassed: result.regressionPassed,
        beta7Passed: result.beta7Passed,
        verified: result.verified,
        rolledBack: result.rolledBack,
        evidence: result.evidence,
        error: result.error,
      };
      const file = path.join(this.artifactRoot, 'mock-attempts', `${safe}-${proposalHash.slice(0, 12)}.json`);
      await writeImmutableJson(file, execution);
      item.latestExecution = {
        file,
        ...(result.branch ? { branch: result.branch } : {}),
        verified: result.verified,
        rolledBack: result.rolledBack,
        ...(result.error ? { error: bounded(result.error, 1_000) } : {}),
      };
      item.phase = result.verified ? 'completed' : result.rolledBack ? 'blocked' : 'error';
      item.message = result.verified
        ? 'Mock migration verified. Changes remain local on the isolated mock branch for operator review/acceptance.'
        : bounded(result.error ?? 'Mock migration execution failed.', 1_000);
      await this.saveState(state);
      if (!result.verified) throw new Error(result.error ?? 'Mock migration execution failed');
      return this.summary();
    });
  }
}
