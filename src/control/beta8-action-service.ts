import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  buildArchitectureInterview,
  validateArchitectureAnswers,
  type ArchitectureAnswer,
  type ArchitectureInterview,
} from '../backend/architecture-interview.js';
import { discoverFrontend, type FrontendDiscoveryResult } from '../backend/frontend-discovery.js';
import { mockMigrationPlanFromBackendBlueprint } from '../backend/mock-migration.js';
import { buildBackendBlueprint, type BackendBlueprint } from '../backend/security-blueprint.js';
import { validateWorkPlan, workPlanFromBackendBlueprint, type WorkPlan } from '../planning/work-item.js';

const MAX_JSON_BYTES = 50_000_000;
const answerSchema = z.object({
  questionId: z.string().min(1).max(200),
  value: z.union([z.string().max(10_000), z.array(z.string().max(1_000)).max(100), z.boolean()]),
  confirmed: z.boolean(),
});

export interface Beta8DashboardActionConfig {
  repoPath?: string;
  artifactRoot?: string;
}

export interface Beta8DashboardSummary {
  available: boolean;
  busy: boolean;
  configuration: { repo: boolean };
  phase: 'not-started' | 'discovered' | 'interview' | 'ready-for-blueprint' | 'blueprint-ready';
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
    workItems: Array<{ id: string; title: string; kind: string; priority: string; dependencies: string[]; status: string }>;
  };
  error?: string;
}

function bounded(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
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

export class Beta8DashboardActionService {
  private busy = false;
  private readonly artifactRoot: string;
  private readonly discoveryPath: string;
  private readonly interviewPath: string;
  private readonly answersPath: string;
  private readonly blueprintPath: string;
  private readonly workPlanPath: string;
  private readonly mockPlanPath: string;

  constructor(private readonly config: Beta8DashboardActionConfig) {
    this.artifactRoot = path.resolve(config.artifactRoot ?? '.qa-backend');
    this.discoveryPath = path.join(this.artifactRoot, 'frontend-discovery.json');
    this.interviewPath = path.join(this.artifactRoot, 'architecture-interview.json');
    this.answersPath = path.join(this.artifactRoot, 'architecture-answers.json');
    this.blueprintPath = path.join(this.artifactRoot, 'backend-blueprint.json');
    this.workPlanPath = path.join(this.artifactRoot, 'work-plan.json');
    this.mockPlanPath = path.join(this.artifactRoot, 'mock-migration-plan.json');
  }

  private requireRepo(): string {
    if (!this.config.repoPath) throw new Error('Beta.8 target frontend repository is not configured for dashboard actions');
    return this.config.repoPath;
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

  async summary(): Promise<Beta8DashboardSummary> {
    try {
      let discovery: FrontendDiscoveryResult | undefined;
      let interview: ArchitectureInterview | undefined;
      let blueprint: BackendBlueprint | undefined;
      let workPlan: WorkPlan | undefined;
      try { discovery = await readBoundedJson<FrontendDiscoveryResult>(this.discoveryPath); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      try { interview = await readBoundedJson<ArchitectureInterview>(this.interviewPath); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      try { blueprint = await readBoundedJson<BackendBlueprint>(this.blueprintPath); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      try { workPlan = await readBoundedJson<WorkPlan>(this.workPlanPath); } catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      const answers = interview ? await this.answers() : [];
      const validation = interview ? validateArchitectureAnswers(interview, answers) : undefined;
      const phase: Beta8DashboardSummary['phase'] = blueprint ? 'blueprint-ready' : validation?.readyForBlueprint ? 'ready-for-blueprint' : answers.length > 0 ? 'interview' : discovery ? 'discovered' : 'not-started';
      return {
        available: Boolean(discovery),
        busy: this.busy,
        configuration: { repo: Boolean(this.config.repoPath) },
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
          workItems: workPlan.items.slice(0, 500).map((item) => ({ id: item.id, title: item.title, kind: item.kind, priority: item.priority, dependencies: [...item.dependencies], status: item.status })),
        } } : {}),
      };
    } catch (error: unknown) {
      return {
        available: false,
        busy: this.busy,
        configuration: { repo: Boolean(this.config.repoPath) },
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
}
