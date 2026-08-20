import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  buildArchitectureInterview,
  validateArchitectureAnswers,
  type ArchitectureAnswer,
  type ArchitectureInterview,
} from '../backend/architecture-interview.js';
import { BackendTaskExecutor } from '../backend/backend-executor.js';
import type { BackendTaskProposal } from '../backend/executor-types.js';
import { discoverFrontend, type FrontendDiscoveryResult } from '../backend/frontend-discovery.js';
import { LocalGitBackendWorkspace } from '../backend/local-git-backend-workspace.js';
import { mockMigrationPlanFromBackendBlueprint } from '../backend/mock-migration.js';
import { buildBackendBlueprint, type BackendBlueprint } from '../backend/security-blueprint.js';
import { approveWorkItem, validateWorkPlan, workPlanFromBackendBlueprint, type WorkPlan } from '../planning/work-item.js';
import { HttpBackendImplementationModel } from '../providers/http-backend-model.js';

const MAX_JSON_BYTES = 50_000_000;
const answerSchema = z.object({
  questionId: z.string().min(1).max(200),
  value: z.union([z.string().max(10_000), z.array(z.string().max(1_000)).max(100), z.boolean()]),
  confirmed: z.boolean(),
});

export interface Beta8DashboardActionConfig {
  repoPath?: string;
  artifactRoot?: string;
  modelEndpoint?: string;
  modelToken?: string;
}

interface Beta8TaskActionState {
  phase?: string;
  message?: string;
  latestProposal?: {
    file: string;
    summary: {
      proposalHash: string;
      scopeHash: string;
      summary: string;
      changes: Array<{ operation: 'create' | 'replace'; path: string }>;
      targetedTests: string[];
      regression: string;
      beta7Qa?: string;
    };
  };
  latestAttempt?: { file: string; outcome: string; branch?: string; error?: string };
}

interface Beta8ActionState {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, Beta8TaskActionState>;
}

export interface Beta8DashboardSummary {
  available: boolean;
  busy: boolean;
  actionsAllowed?: boolean;
  configuration: { repo: boolean; model: boolean };
  phase: 'not-started' | 'discovered' | 'interview' | 'ready-for-blueprint' | 'blueprint-ready' | 'implementation';
  discovery?: {
    projectName: string;
    filesScanned: number;
    frameworks: string[];
    routes: number;
    forms: number;
    apiCandidates: number;
    mockSources: number;
    entities: string[];
  };
  interview?: {
    rounds: ArchitectureInterview['rounds'];
    answers: ArchitectureAnswer[];
    validation: ReturnType<typeof validateArchitectureAnswers>;
  };
  blueprint?: {
    architecture: BackendBlueprint['architecture'];
    securityControls: number;
    threatSurface: number;
    apiEndpoints: number;
    entities: number;
    tasks: number;
    mockMigrationItems: number;
    workPlanValid: boolean;
    workItems: Array<{
      id: string;
      title: string;
      kind: string;
      priority: string;
      dependencies: string[];
      status: string;
      approved: boolean;
      allowedPaths: string[];
      action?: Beta8TaskActionState;
    }>;
  };
  error?: string;
}

function bounded(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function safeArtifactId(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
  if (!safe) throw new Error('work item id cannot produce a safe artifact name');
  return safe;
}

function commandText(command: { program: string; args: string[] } | undefined): string | undefined {
  if (!command) return undefined;
  return `${command.program} ${command.args.join(' ')}`.slice(0, 1_000);
}

async function readBoundedJson<T>(filePath: string): Promise<T> {
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_JSON_BYTES) throw new Error(`Beta.8 artifact exceeds ${MAX_JSON_BYTES} bytes`);
  return JSON.parse(buffer.toString('utf8')) as T;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error(`Beta.8 immutable artifact already exists: ${path.basename(absolute)}`);
    throw error;
  }
}

function defaultActionState(): Beta8ActionState {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), items: {} };
}

export class Beta8DashboardActionService {
  private busy = false;
  private readonly artifactRoot: string;
  private readonly discoveryPath: string;
  private readonly interviewPath: string;
  private readonly answersPath: string;
  private readonly blueprintPath: string;
  private readonly workPlanPath: string;
  private readonly mockPlanPath: string;
  private readonly statePath: string;

  constructor(private readonly config: Beta8DashboardActionConfig) {
    this.artifactRoot = path.resolve(config.artifactRoot ?? '.qa-backend');
    this.discoveryPath = path.join(this.artifactRoot, 'frontend-discovery.json');
    this.interviewPath = path.join(this.artifactRoot, 'architecture-interview.json');
    this.answersPath = path.join(this.artifactRoot, 'architecture-answers.json');
    this.blueprintPath = path.join(this.artifactRoot, 'backend-blueprint.json');
    this.workPlanPath = path.join(this.artifactRoot, 'work-plan.json');
    this.mockPlanPath = path.join(this.artifactRoot, 'mock-migration-plan.json');
    this.statePath = path.join(this.artifactRoot, 'dashboard-action-state.json');
  }

  private requireRepo(): string {
    if (!this.config.repoPath) throw new Error('Beta.8 target frontend repository is not configured for dashboard actions');
    return this.config.repoPath;
  }

  private requireModel(): string {
    if (!this.config.modelEndpoint) throw new Error('Beta.8 backend implementation model endpoint is not configured for dashboard actions');
    return this.config.modelEndpoint;
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('another Beta.8 dashboard action is already running');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  private async answers(): Promise<ArchitectureAnswer[]> {
    try {
      const raw = await readBoundedJson<unknown>(this.answersPath);
      return z.array(answerSchema).max(500).parse(raw);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw error;
    }
  }

  private async actionState(): Promise<Beta8ActionState> {
    try {
      const state = await readBoundedJson<Beta8ActionState>(this.statePath);
      if (state.schemaVersion !== 1 || !state.items || typeof state.items !== 'object') throw new Error('invalid Beta.8 dashboard action state');
      return state;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return defaultActionState();
      throw error;
    }
  }

  private async saveActionState(state: Beta8ActionState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await writePrivateJson(this.statePath, state);
  }

  private async readWorkPlan(): Promise<WorkPlan> {
    const plan = await readBoundedJson<WorkPlan>(this.workPlanPath);
    const validation = validateWorkPlan(plan);
    if (!validation.valid) throw new Error(`invalid Beta.8 work plan: ${JSON.stringify(validation)}`);
    return plan;
  }

  async summary(): Promise<Beta8DashboardSummary> {
    try {
      let discovery: FrontendDiscoveryResult | undefined;
      let interview: ArchitectureInterview | undefined;
      let blueprint: BackendBlueprint | undefined;
      let workPlan: WorkPlan | undefined;
      try { discovery = await readBoundedJson<FrontendDiscoveryResult>(this.discoveryPath); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      try { interview = await readBoundedJson<ArchitectureInterview>(this.interviewPath); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      try { blueprint = await readBoundedJson<BackendBlueprint>(this.blueprintPath); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      try { workPlan = await this.readWorkPlan(); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      const answers = interview ? await this.answers() : [];
      const validation = interview ? validateArchitectureAnswers(interview, answers) : undefined;
      const actions = await this.actionState();
      const hasImplementationProgress = Boolean(workPlan?.items.some((item) => item.status !== 'planned' || item.approval.approved));
      const phase: Beta8DashboardSummary['phase'] = blueprint
        ? hasImplementationProgress ? 'implementation' : 'blueprint-ready'
        : validation?.readyForBlueprint ? 'ready-for-blueprint'
          : answers.length > 0 ? 'interview'
            : discovery ? 'discovered' : 'not-started';
      return {
        available: Boolean(discovery),
        busy: this.busy,
        configuration: { repo: Boolean(this.config.repoPath), model: Boolean(this.config.modelEndpoint) },
        phase,
        ...(discovery ? { discovery: {
          projectName: bounded(discovery.projectName, 200),
          filesScanned: discovery.filesScanned,
          frameworks: discovery.frameworks.map((item) => bounded(item.name, 100)).slice(0, 30),
          routes: discovery.routes.length,
          forms: discovery.forms.length,
          apiCandidates: discovery.apiCandidates.length,
          mockSources: discovery.mockSources.length,
          entities: discovery.entities.map((item) => bounded(item.name, 100)).slice(0, 100),
        } } : {}),
        ...(interview && validation ? { interview: { rounds: interview.rounds, answers, validation } } : {}),
        ...(blueprint && workPlan ? { blueprint: {
          architecture: blueprint.architecture,
          securityControls: blueprint.security.controls.length,
          threatSurface: blueprint.security.threatSurface.length,
          apiEndpoints: blueprint.apiPlan.length,
          entities: blueprint.dataModel.length,
          tasks: blueprint.tasks.length,
          mockMigrationItems: blueprint.mockMigration.length,
          workPlanValid: validateWorkPlan(workPlan).valid,
          workItems: workPlan.items.slice(0, 500).map((item) => ({
            id: item.id,
            title: item.title,
            kind: item.kind,
            priority: item.priority,
            dependencies: [...item.dependencies],
            status: item.status,
            approved: Boolean(item.approval.approved),
            allowedPaths: [...item.execution.allowedPaths],
            ...(actions.items[item.id] ? { action: actions.items[item.id] } : {}),
          })),
        } } : {}),
      };
    } catch (error: unknown) {
      return {
        available: false,
        busy: this.busy,
        configuration: { repo: Boolean(this.config.repoPath), model: Boolean(this.config.modelEndpoint) },
        phase: 'not-started',
        error: bounded(error instanceof Error ? error.message : error, 1_000),
      };
    }
  }

  async discover(): Promise<Beta8DashboardSummary> {
    return this.mutate(async () => {
      const repo = this.requireRepo();
      try {
        await readFile(this.blueprintPath);
        throw new Error('Beta.8 blueprint already exists; refusing to replace confirmed architecture artifacts from the dashboard');
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      const discovery = await discoverFrontend(repo);
      const interview = buildArchitectureInterview(discovery);
      await writePrivateJson(this.discoveryPath, discovery);
      await writePrivateJson(this.interviewPath, interview);
      await writePrivateJson(this.answersPath, []);
      return this.summary();
    });
  }

  async answer(input: ArchitectureAnswer): Promise<Beta8DashboardSummary> {
    return this.mutate(async () => {
      const interview = await readBoundedJson<ArchitectureInterview>(this.interviewPath);
      const parsed = answerSchema.parse(input);
      const question = interview.rounds.flatMap((round) => round.questions).find((candidate) => candidate.id === parsed.questionId);
      if (!question) throw new Error(`unknown Beta.8 architecture question: ${parsed.questionId}`);
      if (question.requiresExplicitConfirmation && !parsed.confirmed) throw new Error('this architecture decision requires explicit confirmation');
      const current = await this.answers();
      const next = current.filter((answer) => answer.questionId !== parsed.questionId);
      next.push(parsed);
      const validation = validateArchitectureAnswers(interview, next);
      if (validation.invalid.includes(parsed.questionId)) throw new Error(`invalid answer for ${parsed.questionId}`);
      await writePrivateJson(this.answersPath, next);
      return this.summary();
    });
  }

  async generateBlueprint(): Promise<Beta8DashboardSummary> {
    return this.mutate(async () => {
      const [discovery, interview, answers] = await Promise.all([
        readBoundedJson<FrontendDiscoveryResult>(this.discoveryPath),
        readBoundedJson<ArchitectureInterview>(this.interviewPath),
        this.answers(),
      ]);
      const validation = validateArchitectureAnswers(interview, answers);
      if (!validation.readyForBlueprint) throw new Error(`architecture interview is not ready for blueprint generation: missing=${validation.missing.join(',')} unconfirmed=${validation.unconfirmed.join(',')} invalid=${validation.invalid.join(',')}`);
      const blueprint = buildBackendBlueprint({ discovery, interview, answers });
      const workPlan = workPlanFromBackendBlueprint(blueprint);
      const mockPlan = mockMigrationPlanFromBackendBlueprint(blueprint);
      await writeImmutableJson(this.blueprintPath, blueprint);
      await writeImmutableJson(this.workPlanPath, workPlan);
      await writeImmutableJson(this.mockPlanPath, mockPlan);
      return this.summary();
    });
  }

  async approveTask(itemId: string, approvedBy: string, allowedPaths: string[]): Promise<Beta8DashboardSummary> {
    return this.mutate(async () => {
      if (allowedPaths.length < 1 || allowedPaths.length > 32) throw new Error('Beta.8 task approval requires 1-32 repository-relative allowed paths');
      if (allowedPaths.some((value) => typeof value !== 'string' || !value.trim() || value.length > 500)) throw new Error('invalid Beta.8 task approval path');
      const plan = await this.readWorkPlan();
      approveWorkItem(plan, itemId, { approvedBy: bounded(approvedBy, 120), allowedPaths });
      await writePrivateJson(this.workPlanPath, plan);
      const state = await this.actionState();
      state.items[itemId] = { phase: 'approved', message: 'Exact repository scope approved. Generate and review a bounded implementation proposal next.' };
      await this.saveActionState(state);
      return this.summary();
    });
  }

  async proposeTask(itemId: string): Promise<Beta8DashboardSummary> {
    return this.mutate(async () => {
      const repo = this.requireRepo();
      const endpoint = this.requireModel();
      const plan = await this.readWorkPlan();
      const state = await this.actionState();
      const itemState = state.items[itemId] ?? {};
      state.items[itemId] = itemState;
      itemState.phase = 'planning';
      itemState.message = 'Generating a bounded security-first backend proposal from approved scope and safe source context.';
      await this.saveActionState(state);
      try {
        const executor = new BackendTaskExecutor(new HttpBackendImplementationModel(endpoint, this.config.modelToken), new LocalGitBackendWorkspace(repo));
        const result = await executor.propose(plan, itemId);
        if (!result.planned || !result.proposal) throw new Error(result.error ?? 'Beta.8 backend proposal generation failed');
        const proposal = result.proposal;
        const safe = safeArtifactId(itemId);
        const file = path.join(this.artifactRoot, 'proposals', `${safe}-${proposal.proposalHash.slice(0, 12)}.json`);
        await writeImmutableJson(file, proposal);
        itemState.phase = 'proposal-ready';
        itemState.message = 'Proposal generated. Review exact files and verification commands before execution.';
        itemState.latestProposal = {
          file,
          summary: {
            proposalHash: proposal.proposalHash,
            scopeHash: proposal.scopeHash,
            summary: bounded(proposal.summary, 3_000),
            changes: proposal.changes.map((change) => ({ operation: change.operation, path: bounded(change.path, 500) })),
            targetedTests: proposal.targetedTests.map((command) => commandText(command)!),
            regression: commandText(proposal.regression)!,
            ...(proposal.beta7Qa ? { beta7Qa: commandText(proposal.beta7Qa)! } : {}),
          },
        };
        await this.saveActionState(state);
        return this.summary();
      } catch (error: unknown) {
        itemState.phase = 'error';
        itemState.message = bounded(error instanceof Error ? error.message : error, 1_000);
        await this.saveActionState(state);
        throw error;
      }
    });
  }

  async executeTask(itemId: string, proposalHash: string, confirmWrite: boolean): Promise<Beta8DashboardSummary> {
    return this.mutate(async () => {
      if (!confirmWrite) throw new Error('Beta.8 task execution requires explicit write confirmation');
      const repo = this.requireRepo();
      const plan = await this.readWorkPlan();
      const state = await this.actionState();
      const itemState = state.items[itemId];
      const latest = itemState?.latestProposal;
      if (!latest) throw new Error('no reviewed Beta.8 proposal is available for this task');
      if (latest.summary.proposalHash !== proposalHash) throw new Error('requested proposal hash is not the latest reviewed Beta.8 proposal');
      const proposal = await readBoundedJson<BackendTaskProposal>(latest.file);
      if (proposal.proposalHash !== proposalHash) throw new Error('stored Beta.8 proposal no longer matches dashboard metadata');
      itemState.phase = 'executing';
      itemState.message = 'Applying the exact reviewed proposal on an isolated branch, then running targeted, regression and Beta.7 gates.';
      await this.saveActionState(state);
      try {
        const unusedModel = { async propose(): Promise<never> { throw new Error('model is not used during execution'); } };
        const executor = new BackendTaskExecutor(unusedModel, new LocalGitBackendWorkspace(repo));
        const result = await executor.execute(plan, itemId, proposal, { confirmProposalHash: proposalHash, attempt: 1 });
        await writePrivateJson(this.workPlanPath, plan);
        const safe = safeArtifactId(itemId);
        const file = path.join(this.artifactRoot, 'attempts', `${safe}-attempt-1-${proposalHash.slice(0, 12)}.json`);
        await writeImmutableJson(file, result.attemptRecord);
        itemState.latestAttempt = {
          file,
          outcome: result.attemptRecord.outcome,
          ...(result.branch ? { branch: result.branch } : {}),
          ...(result.error ? { error: bounded(result.error, 1_000) } : {}),
        };
        itemState.phase = result.verified ? 'completed' : 'blocked';
        itemState.message = result.verified
          ? 'Task verification passed. Changes remain uncommitted on the isolated branch for review.'
          : bounded(result.error ?? 'Task execution failed and rollback was attempted.', 1_000);
        await this.saveActionState(state);
        return this.summary();
      } catch (error: unknown) {
        itemState.phase = 'error';
        itemState.message = bounded(error instanceof Error ? error.message : error, 1_000);
        await this.saveActionState(state);
        throw error;
      }
    });
  }
}
