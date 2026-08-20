import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildFeatureBlueprint,
  buildFeaturePlanningSession,
  validateFeaturePlanningAnswers,
  type FeatureBlueprint,
  type FeaturePlanningAnswer,
  type FeaturePlanningSession,
  type ProductOpportunity,
} from '../planning/feature-planner.js';
import { validateWorkPlan } from '../planning/work-item.js';

const MAX_ARTIFACT_BYTES = 5_000_000;
const MAX_LIST_ITEMS = 200;

export interface FeaturePlannerCreateInput {
  project: string;
  title: string;
  observation: string;
  userValue: string;
  expectedImpact: 'high' | 'medium' | 'low';
  estimatedEffort: 'high' | 'medium' | 'low';
  affectedAreas: string[];
  designSystemConstraints: string[];
  currentProductUnderstanding: string[];
}

export interface FeaturePlannerBlueprintInput {
  selectedAlternativeId: string;
  userFlow: string[];
  informationArchitecture: string[];
  frontendRequirements: string[];
  backendRequirements: string[];
  dataRequirements: string[];
  securityRequirements: string[];
}

export interface FeaturePlannerDashboardSummary {
  available: boolean;
  phase: 'empty' | 'interview' | 'ready-for-blueprint' | 'blueprint-ready';
  session?: FeaturePlanningSession;
  answers?: FeaturePlanningAnswer[];
  validation?: ReturnType<typeof validateFeaturePlanningAnswers>;
  blueprint?: FeatureBlueprint;
  workPlanValid?: boolean;
  error?: string;
}

function bounded(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function boundedList(values: unknown, maxItems = MAX_LIST_ITEMS): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => bounded(value, 1_000))
    .filter(Boolean))].slice(0, maxItems);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return normalized || 'feature-request';
}

async function readBoundedJson<T>(filePath: string): Promise<T> {
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_ARTIFACT_BYTES) throw new Error(`feature planning artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  return JSON.parse(buffer.toString('utf8')) as T;
}

async function optionalJson<T>(filePath: string): Promise<T | undefined> {
  try { return await readBoundedJson<T>(filePath); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writePrivateJson(filePath: string, value: unknown, exclusive = false): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    ...(exclusive ? { flag: 'wx' as const } : {}),
  });
}

function normalizeAnswer(session: FeaturePlanningSession, questionId: string, value: unknown): FeaturePlanningAnswer {
  const question = session.questions.find((candidate) => candidate.id === questionId);
  if (!question) throw new Error(`unknown feature planning question: ${questionId}`);
  let normalized: string | string[] | boolean;
  if (question.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${questionId} requires a boolean answer`);
    normalized = value;
  } else if (question.kind === 'multi') {
    const values = boundedList(value, 50);
    if (values.length === 0) throw new Error(`${questionId} requires at least one selection`);
    if (question.options && values.some((candidate) => !question.options!.includes(candidate))) throw new Error(`${questionId} contains an unsupported option`);
    normalized = values;
  } else {
    if (typeof value !== 'string' || !bounded(value, 2_000)) throw new Error(`${questionId} requires a non-empty string answer`);
    normalized = bounded(value, 2_000);
    if (question.kind === 'single' && question.options && !question.options.includes(normalized)) throw new Error(`${questionId} contains an unsupported option`);
  }
  return { questionId, value: normalized, confirmed: true };
}

export class FeaturePlannerDashboardService {
  private readonly root: string;
  private readonly sessionPath: string;
  private readonly answersPath: string;
  private readonly blueprintPath: string;

  constructor(artifactRoot = '.qa-features') {
    this.root = path.resolve(artifactRoot);
    this.sessionPath = path.join(this.root, 'planning-session.json');
    this.answersPath = path.join(this.root, 'planning-answers.json');
    this.blueprintPath = path.join(this.root, 'feature-blueprint.json');
  }

  async summary(): Promise<FeaturePlannerDashboardSummary> {
    try {
      const session = await optionalJson<FeaturePlanningSession>(this.sessionPath);
      if (!session) return { available: false, phase: 'empty' };
      const answers = await optionalJson<FeaturePlanningAnswer[]>(this.answersPath) ?? [];
      const validation = validateFeaturePlanningAnswers(session, answers);
      const blueprint = await optionalJson<FeatureBlueprint>(this.blueprintPath);
      if (blueprint) {
        return {
          available: true,
          phase: 'blueprint-ready',
          session,
          answers,
          validation,
          blueprint,
          workPlanValid: validateWorkPlan(blueprint.workPlan).valid,
        };
      }
      return {
        available: true,
        phase: validation.ready ? 'ready-for-blueprint' : 'interview',
        session,
        answers,
        validation,
      };
    } catch (error: unknown) {
      return { available: false, phase: 'empty', error: bounded(error instanceof Error ? error.message : error, 1_000) };
    }
  }

  async create(input: FeaturePlannerCreateInput): Promise<FeaturePlannerDashboardSummary> {
    if (await optionalJson<FeaturePlanningSession>(this.sessionPath)) throw new Error('feature planning session already exists; refusing to overwrite active product decisions');
    const project = bounded(input.project, 200);
    const title = bounded(input.title, 300);
    const observation = bounded(input.observation, 2_000);
    const userValue = bounded(input.userValue, 2_000);
    if (!project || !title || !observation || !userValue) throw new Error('project, title, observation and userValue are required');
    if (!['high', 'medium', 'low'].includes(input.expectedImpact)) throw new Error('expectedImpact must be high, medium or low');
    if (!['high', 'medium', 'low'].includes(input.estimatedEffort)) throw new Error('estimatedEffort must be high, medium or low');
    const id = slug(title);
    const opportunity: ProductOpportunity = {
      id,
      source: 'user-request',
      title,
      observation,
      userValue,
      expectedImpact: input.expectedImpact,
      estimatedEffort: input.estimatedEffort,
      confidence: 1,
      evidence: [`dashboard:user-request:${id}`],
      affectedAreas: boundedList(input.affectedAreas),
      designSystemConstraints: boundedList(input.designSystemConstraints),
    };
    const session = buildFeaturePlanningSession({
      project,
      opportunity,
      currentProductUnderstanding: boundedList(input.currentProductUnderstanding, 500),
    });
    await writePrivateJson(this.sessionPath, session, true);
    await writePrivateJson(this.answersPath, []);
    return this.summary();
  }

  async answer(questionId: string, value: unknown, confirmed: boolean): Promise<FeaturePlannerDashboardSummary> {
    if (confirmed !== true) throw new Error('feature planning answer requires confirmed=true');
    if (await optionalJson<FeatureBlueprint>(this.blueprintPath)) throw new Error('feature blueprint is already frozen; planning answers cannot be changed');
    const session = await optionalJson<FeaturePlanningSession>(this.sessionPath);
    if (!session) throw new Error('feature planning session is not available');
    const normalized = normalizeAnswer(session, bounded(questionId, 200), value);
    const answers = await optionalJson<FeaturePlanningAnswer[]>(this.answersPath) ?? [];
    const next = answers.filter((answer) => answer.questionId !== normalized.questionId);
    next.push(normalized);
    await writePrivateJson(this.answersPath, next);
    return this.summary();
  }

  async blueprint(input: FeaturePlannerBlueprintInput): Promise<FeaturePlannerDashboardSummary> {
    if (await optionalJson<FeatureBlueprint>(this.blueprintPath)) throw new Error('feature blueprint already exists; refusing to overwrite the approved planning contract');
    const session = await optionalJson<FeaturePlanningSession>(this.sessionPath);
    if (!session) throw new Error('feature planning session is not available');
    const answers = await optionalJson<FeaturePlanningAnswer[]>(this.answersPath) ?? [];
    const validation = validateFeaturePlanningAnswers(session, answers);
    if (!validation.ready) throw new Error(`feature planning is not ready for blueprint: ${JSON.stringify(validation)}`);
    const userFlow = boundedList(input.userFlow);
    const frontendRequirements = boundedList(input.frontendRequirements);
    const securityRequirements = boundedList(input.securityRequirements);
    if (userFlow.length === 0) throw new Error('feature blueprint requires at least one explicit user-flow step');
    if (frontendRequirements.length === 0) throw new Error('feature blueprint requires at least one explicit frontend requirement');
    if (securityRequirements.length === 0) throw new Error('feature blueprint requires at least one explicit security requirement');
    const blueprint = buildFeatureBlueprint({
      session,
      answers,
      selectedAlternativeId: bounded(input.selectedAlternativeId, 100),
      userFlow,
      informationArchitecture: boundedList(input.informationArchitecture),
      frontendRequirements,
      backendRequirements: boundedList(input.backendRequirements),
      dataRequirements: boundedList(input.dataRequirements),
      securityRequirements,
    });
    if (!validateWorkPlan(blueprint.workPlan).valid) throw new Error('generated feature work plan failed deterministic safety validation');
    await writePrivateJson(this.blueprintPath, blueprint, true);
    return this.summary();
  }
}
