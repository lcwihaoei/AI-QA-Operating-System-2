import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BackendVerificationCommand } from '../backend/executor-types.js';
import { LocalGitBackendWorkspace } from '../backend/local-git-backend-workspace.js';
import { validateBackendVerificationCommand } from '../backend/backend-executor.js';
import type { MockMigrationPlan } from '../backend/mock-migration.js';
import type { WorkPlan } from '../planning/work-item.js';
import { createBeta9SelectionFromDashboard, loadBeta9FindingSource, type Beta9DashboardFindingSource, type Beta9DashboardSummary } from './beta9-dashboard.js';

const MAX_RESULT_BYTES = 50_000_000;
const MAX_STATE_BYTES = 5_000_000;
const MAX_RUN_DIRECTORIES = 10_000;

const findingSchema = z.object({
  id: z.string().max(500),
  kind: z.enum(['console', 'page-error', 'network', 'ui', 'navigation', 'assertion']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string().max(5_000),
  url: z.string().max(10_000),
  message: z.string().max(20_000),
  reproduction: z.array(z.string().max(5_000)).max(500),
  evidence: z.array(z.string().max(5_000)).max(2_000),
  fingerprint: z.string().min(1).max(500),
});
const resultSchema = z.object({
  runId: z.string().min(1).max(500),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  findings: z.array(findingSchema).max(20_000),
  report: z.object({
    enabled: z.boolean(),
    htmlPath: z.string().max(10_000).optional(),
    dataPath: z.string().max(10_000).optional(),
    markdownPath: z.string().max(10_000).optional(),
    videos: z.number().int().nonnegative().optional(),
    findings: z.number().int().nonnegative().optional(),
    uxOpportunities: z.number().int().nonnegative().optional(),
    toolingError: z.string().max(10_000).optional(),
  }).optional(),
}).passthrough();

interface HandoffState {
  schemaVersion: 1;
  runId: string;
  resultPath: string;
  qaStartedAt: string;
  qaFinishedAt: string;
  command: BackendVerificationCommand;
  counts: Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>;
  blockingFindings: number;
}

export interface Beta8QaHandoffConfig {
  repoPath?: string;
  artifactRoot?: string;
  runsRoot?: string;
  exactResultPath?: string;
  beta9PlanPath?: string;
}

export interface Beta8QaHandoffSummary {
  available: boolean;
  configuration: { repo: boolean; runsRoot: boolean; exactResult: boolean; beta9Plan: boolean };
  readyToRun: boolean;
  blockers: string[];
  qa?: {
    runId: string;
    result: string;
    qaStartedAt: string;
    qaFinishedAt: string;
    command: string;
    counts: Record<string, number>;
    blockingFindings: number;
    report?: { enabled: boolean; html?: string; markdown?: string; videos?: number; toolingError?: string };
  };
  findings?: Beta9DashboardFindingSource;
  error?: string;
}

function bounded(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function visiblePath(repoRoot: string, absolute: string): string {
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : path.basename(absolute);
}

async function readBoundedJson<T>(filePath: string, maxBytes = MAX_STATE_BYTES): Promise<T> {
  const buffer = await readFile(filePath);
  if (buffer.length > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes: ${path.basename(filePath)}`);
  return JSON.parse(buffer.toString('utf8')) as T;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function validResult(filePath: string) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Beta.7 result must be a regular non-symlink file');
  return { parsed: resultSchema.parse(await readBoundedJson<unknown>(filePath, MAX_RESULT_BYTES)), stat };
}

export class Beta8QaHandoffService {
  private readonly artifactRoot: string;
  private readonly statePath: string;
  private readonly workPlanPath: string;
  private readonly mockPlanPath: string;
  private readonly runsRoot?: string;

  constructor(private readonly config: Beta8QaHandoffConfig) {
    this.artifactRoot = path.resolve(config.artifactRoot ?? '.qa-backend');
    this.statePath = path.join(this.artifactRoot, 'final-qa-handoff.json');
    this.workPlanPath = path.join(this.artifactRoot, 'work-plan.json');
    this.mockPlanPath = path.join(this.artifactRoot, 'mock-migration-plan.json');
    this.runsRoot = config.runsRoot ? path.resolve(config.runsRoot) : config.repoPath ? path.resolve(config.repoPath, '.qa-runs') : undefined;
  }

  private requireRepo(): string {
    if (!this.config.repoPath) throw new Error('Beta.8 target repository is not configured for final QA');
    return path.resolve(this.config.repoPath);
  }

  private async readiness(): Promise<{ ready: boolean; blockers: string[]; workPlan?: WorkPlan }> {
    const blockers: string[] = [];
    let workPlan: WorkPlan | undefined;
    try {
      workPlan = await readBoundedJson<WorkPlan>(this.workPlanPath);
      const incomplete = workPlan.items.filter((item) => item.kind !== 'qa' && item.status !== 'completed').map((item) => item.id);
      if (incomplete.length > 0) blockers.push(`incomplete implementation tasks: ${incomplete.slice(0, 20).join(', ')}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') blockers.push('Beta.8 Work Plan is not available');
      else throw error;
    }
    try {
      const mocks = await readBoundedJson<MockMigrationPlan>(this.mockPlanPath);
      const incomplete = mocks.records.filter((record) => record.status !== 'completed').map((record) => record.id);
      if (incomplete.length > 0) blockers.push(`incomplete mock decisions: ${incomplete.slice(0, 20).join(', ')}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    return { ready: blockers.length === 0, blockers, ...(workPlan ? { workPlan } : {}) };
  }

  private async scanRuns(): Promise<Map<string, string>> {
    if (!this.runsRoot) throw new Error('Beta.7 run root is not configured');
    const entries = await readdir(this.runsRoot, { withFileTypes: true });
    if (entries.length > MAX_RUN_DIRECTORIES) throw new Error(`Beta.7 run root exceeds ${MAX_RUN_DIRECTORIES} entries; configure an exact result path`);
    const found = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.resolve(this.runsRoot, entry.name, 'result.json');
      if (!inside(this.runsRoot, candidate)) continue;
      try {
        const { parsed } = await validResult(candidate);
        found.set(candidate, parsed.runId);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR' || error instanceof SyntaxError || error instanceof z.ZodError) continue;
        throw error;
      }
    }
    return found;
  }

  private async discoverNewResult(before: Map<string, string>, startedAtMs: number): Promise<{ path: string; parsed: z.infer<typeof resultSchema> }> {
    if (this.config.exactResultPath) {
      const repo = this.requireRepo();
      const exact = path.resolve(this.config.exactResultPath);
      if (!inside(repo, exact)) throw new Error('explicit Beta.7 result must remain inside the configured target repository');
      const { parsed } = await validResult(exact);
      if ([...before.entries()].some(([candidate, runId]) => candidate === exact && runId === parsed.runId)) throw new Error('explicit Beta.7 result predates this final QA run');
      return { path: exact, parsed };
    }
    const after = await this.scanRuns();
    const candidates: Array<{ path: string; parsed: z.infer<typeof resultSchema>; mtimeMs: number }> = [];
    for (const [candidate, runId] of after) {
      if (before.get(candidate) === runId) continue;
      try {
        const { parsed, stat } = await validResult(candidate);
        if (stat.mtimeMs + 1_000 < startedAtMs) continue;
        candidates.push({ path: candidate, parsed, mtimeMs: stat.mtimeMs });
      } catch (error: unknown) {
        if (error instanceof SyntaxError || error instanceof z.ZodError) continue;
        throw error;
      }
    }
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    if (candidates.length === 0) throw new Error('no new Beta.7 result was produced by the final Beta.8 QA command');
    if (candidates.length > 1) throw new Error(`multiple new Beta.7 results (${candidates.length}) were produced; configure an exact result path instead of guessing`);
    return { path: candidates[0]!.path, parsed: candidates[0]!.parsed };
  }

  private async savedState(): Promise<HandoffState | undefined> {
    try { return await readBoundedJson<HandoffState>(this.statePath); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; throw error; }
  }

  async summary(): Promise<Beta8QaHandoffSummary> {
    try {
      const repo = this.config.repoPath ? path.resolve(this.config.repoPath) : undefined;
      const readiness = await this.readiness();
      const state = await this.savedState();
      if (!state || !repo) {
        return {
          available: Boolean(state),
          configuration: { repo: Boolean(repo), runsRoot: Boolean(this.runsRoot), exactResult: Boolean(this.config.exactResultPath), beta9Plan: Boolean(this.config.beta9PlanPath) },
          readyToRun: readiness.ready,
          blockers: readiness.blockers,
        };
      }
      const { parsed } = await validResult(state.resultPath);
      if (parsed.runId !== state.runId) throw new Error('saved Beta.8 final QA result no longer matches its recorded run id');
      const findings = await loadBeta9FindingSource(state.resultPath, this.config.beta9PlanPath ?? '.qa-beta9/plan.json');
      const report = parsed.report;
      const reportSummary = report ? {
        enabled: report.enabled,
        ...(report.htmlPath ? { html: visiblePath(repo, path.resolve(report.htmlPath)) } : {}),
        ...(report.markdownPath ? { markdown: visiblePath(repo, path.resolve(report.markdownPath)) } : {}),
        ...(report.videos !== undefined ? { videos: report.videos } : {}),
        ...(report.toolingError ? { toolingError: bounded(report.toolingError, 1_000) } : {}),
      } : undefined;
      return {
        available: true,
        configuration: { repo: true, runsRoot: Boolean(this.runsRoot), exactResult: Boolean(this.config.exactResultPath), beta9Plan: Boolean(this.config.beta9PlanPath) },
        readyToRun: readiness.ready,
        blockers: readiness.blockers,
        qa: {
          runId: state.runId,
          result: visiblePath(repo, state.resultPath),
          qaStartedAt: state.qaStartedAt,
          qaFinishedAt: state.qaFinishedAt,
          command: `${state.command.program} ${state.command.args.join(' ')}`,
          counts: state.counts,
          blockingFindings: state.blockingFindings,
          ...(reportSummary ? { report: reportSummary } : {}),
        },
        findings,
      };
    } catch (error: unknown) {
      return {
        available: false,
        configuration: { repo: Boolean(this.config.repoPath), runsRoot: Boolean(this.runsRoot), exactResult: Boolean(this.config.exactResultPath), beta9Plan: Boolean(this.config.beta9PlanPath) },
        readyToRun: false,
        blockers: [],
        error: bounded(error instanceof Error ? error.message : error, 1_000),
      };
    }
  }

  async run(command: BackendVerificationCommand): Promise<Beta8QaHandoffSummary> {
    const repo = this.requireRepo();
    const error = validateBackendVerificationCommand(command);
    if (error) throw new Error(error);
    const readiness = await this.readiness();
    if (!readiness.ready) throw new Error(`Beta.8 final QA is blocked: ${readiness.blockers.join('; ')}`);
    if (await this.savedState()) throw new Error('Beta.8 final QA handoff already exists; refusing to overwrite audited QA evidence');
    const before = this.config.exactResultPath ? await this.scanRuns().catch(() => new Map<string, string>()) : await this.scanRuns();
    const qaStartedAt = new Date().toISOString();
    const startedAtMs = Date.parse(qaStartedAt);
    const result = await new LocalGitBackendWorkspace(repo).run(command);
    const qaFinishedAt = new Date().toISOString();
    if (result.exitCode !== 0) throw new Error(`Beta.8 final Beta.7 QA command failed with exit code ${result.exitCode}`);
    const discovered = await this.discoverNewResult(before, startedAtMs);
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of discovered.parsed.findings) counts[finding.severity] += 1;
    const blockingFindings = counts.critical + counts.high;
    const state: HandoffState = {
      schemaVersion: 1,
      runId: discovered.parsed.runId,
      resultPath: discovered.path,
      qaStartedAt,
      qaFinishedAt,
      command: { program: command.program, args: [...command.args] },
      counts,
      blockingFindings,
    };
    await writePrivateJson(this.statePath, state);

    if (readiness.workPlan) {
      const qaItem = readiness.workPlan.items.find((item) => item.id === 'B8-QA-001' || item.kind === 'qa');
      if (qaItem) qaItem.status = blockingFindings > 0 ? 'blocked' : 'completed';
      await writePrivateJson(this.workPlanPath, readiness.workPlan);
    }
    return this.summary();
  }

  async sendToBeta9(fingerprints: string[], project?: string): Promise<Beta9DashboardSummary> {
    const state = await this.savedState();
    if (!state) throw new Error('Beta.8 final QA result is not available for Beta.9 handoff');
    const planPath = this.config.beta9PlanPath;
    if (!planPath) throw new Error('Beta.9 plan path is not configured for Beta.8 handoff');
    return createBeta9SelectionFromDashboard({
      resultPath: state.resultPath,
      planPath,
      fingerprints,
      project: bounded(project ?? `Beta.8 QA handoff ${state.runId}`, 200),
    });
  }
}
