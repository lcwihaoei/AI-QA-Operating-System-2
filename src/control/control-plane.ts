import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlannerExecutionOutcome, QaRunResult, Severity } from '../core/types.js';

export type ControlJobStatus = 'queued' | 'leased' | 'completed' | 'failed';
export type WorkerStatus = 'online' | 'busy' | 'offline';

export interface ControlRunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  coverageScore: number;
  pageCoverage?: number;
  rawInteractionCoverage?: number;
  eligibleInteractionCoverage?: number;
  unexplainedEligibleGaps?: number;
  plannerStatus?: PlannerExecutionOutcome;
  plannerPagesModelUsed?: number;
  plannerPagesAttempted?: number;
  plannerFallbackPages?: number;
  uxReasonerOutcome?: string;
  findingClusters?: number;
  rawFindings?: number;
  uxScore?: number;
  uxOpportunities?: number;
  findings: Record<Severity, number>;
  visited: number;
  browserActions: number;
  deviceActions: number;
  outputDir: string;
}

export interface ControlWorker { id: string; capabilities: string[]; status: WorkerStatus; lastSeenAt: string; activeJobId?: string; }
export interface ControlJob {
  id: string; project: string; url: string; priority: number; status: ControlJobStatus; createdAt: string; attempts: number; maxAttempts: number;
  requiredCapabilities: string[]; leasedBy?: string; leasedAt?: string; completedAt?: string;
}
export interface ControlPlaneDocument { version: 1; revision: number; updatedAt: string; runs: ControlRunRecord[]; workers: ControlWorker[]; jobs: ControlJob[]; }

const MAX_FILE_BYTES = 10_000_000, MAX_RUNS = 2_000, MAX_WORKERS = 500, MAX_JOBS = 5_000;
function blank(): ControlPlaneDocument { return { version: 1, revision: 0, updatedAt: new Date().toISOString(), runs: [], workers: [], jobs: [] }; }
function safeString(value: string, max: number): string { return value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function counts(result: QaRunResult): Record<Severity, number> {
  const value: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of result.findings) value[finding.severity] += 1;
  return value;
}
function isDocument(value: unknown): value is ControlPlaneDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && Number.isInteger(record.revision) && Array.isArray(record.runs) && record.runs.length <= MAX_RUNS
    && Array.isArray(record.workers) && record.workers.length <= MAX_WORKERS && Array.isArray(record.jobs) && record.jobs.length <= MAX_JOBS;
}

export class ControlPlaneStore {
  constructor(private readonly filePath = '.qa-control/state.json') {}
  get path(): string { return this.filePath; }
  async load(): Promise<ControlPlaneDocument> {
    try {
      const buffer = await readFile(this.filePath);
      if (buffer.length > MAX_FILE_BYTES) throw new Error('control-plane state exceeds 10 MB');
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
      if (!isDocument(parsed)) throw new Error('control-plane state has unsupported schema');
      return parsed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return blank();
      throw error;
    }
  }
  async save(document: ControlPlaneDocument): Promise<void> {
    const next: ControlPlaneDocument = { ...document, revision: document.revision + 1, updatedAt: new Date().toISOString(), runs: document.runs.slice(-MAX_RUNS), workers: document.workers.slice(-MAX_WORKERS), jobs: document.jobs.slice(-MAX_JOBS) };
    await mkdir(path.dirname(path.resolve(this.filePath)), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  async recordRun(result: QaRunResult): Promise<ControlRunRecord> {
    const document = await this.load();
    const record: ControlRunRecord = {
      runId: safeString(result.runId, 200),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      coverageScore: result.coverage.score,
      pageCoverage: result.coverage.pageCoverage,
      rawInteractionCoverage: result.coverage.rawInteractionCoverage ?? result.coverage.interactionCoverage,
      eligibleInteractionCoverage: result.coverage.eligibleInteractionCoverage ?? result.coverage.interactionCoverage,
      unexplainedEligibleGaps: result.coverage.unexplainedEligibleGaps ?? 0,
      plannerStatus: result.planner?.status,
      plannerPagesModelUsed: result.planner?.pagesModelUsed,
      plannerPagesAttempted: result.planner?.pagesAttempted,
      plannerFallbackPages: result.planner?.pagesFallback,
      uxReasonerOutcome: result.ux?.reasonerStatus?.outcome,
      findingClusters: result.findingClusters?.clusters,
      rawFindings: result.findings.length,
      uxScore: result.ux?.score,
      uxOpportunities: result.ux?.opportunities,
      findings: counts(result),
      visited: result.visitedUrls.length,
      browserActions: result.actions,
      deviceActions: result.device.actions,
      outputDir: safeString(result.outputDir, 1_000),
    };
    document.runs = [...document.runs.filter((item) => item.runId !== record.runId), record];
    await this.save(document); return record;
  }
  async heartbeat(workerId: string, capabilities: string[], status: WorkerStatus = 'online'): Promise<ControlWorker> {
    const id = safeString(workerId, 100); if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('invalid worker id');
    const document = await this.load(); const current = document.workers.find((item) => item.id === id);
    const worker: ControlWorker = { id, capabilities: [...new Set(capabilities.map((value) => safeString(value, 80)).filter(Boolean))].slice(0, 50), status, lastSeenAt: new Date().toISOString(), activeJobId: current?.activeJobId };
    document.workers = [...document.workers.filter((item) => item.id !== id), worker]; await this.save(document); return worker;
  }
  async enqueue(input: Pick<ControlJob, 'project' | 'url' | 'requiredCapabilities'> & { priority?: number; maxAttempts?: number }): Promise<ControlJob> {
    const parsedUrl = new URL(input.url); if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('control job URL must use HTTP(S)');
    const document = await this.load();
    const job: ControlJob = { id: randomUUID(), project: safeString(input.project, 200), url: parsedUrl.toString().slice(0, 2_000), priority: Math.max(-100, Math.min(input.priority ?? 0, 100)), status: 'queued', createdAt: new Date().toISOString(), attempts: 0, maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? 3, 10)), requiredCapabilities: [...new Set(input.requiredCapabilities.map((value) => safeString(value, 80)).filter(Boolean))].slice(0, 50) };
    document.jobs.push(job); await this.save(document); return job;
  }
  async lease(workerId: string): Promise<ControlJob | undefined> {
    const document = await this.load(); const worker = document.workers.find((item) => item.id === workerId);
    if (!worker) throw new Error('worker must heartbeat before leasing'); if (worker.activeJobId) return document.jobs.find((item) => item.id === worker.activeJobId);
    const capabilities = new Set(worker.capabilities);
    const job = document.jobs.filter((item) => item.status === 'queued' && item.attempts < item.maxAttempts && item.requiredCapabilities.every((capability) => capabilities.has(capability)))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return undefined; job.status = 'leased'; job.leasedBy = workerId; job.leasedAt = new Date().toISOString(); job.attempts += 1;
    worker.status = 'busy'; worker.activeJobId = job.id; worker.lastSeenAt = new Date().toISOString(); await this.save(document); return job;
  }
  async complete(workerId: string, jobId: string, success: boolean): Promise<void> {
    const document = await this.load(); const worker = document.workers.find((item) => item.id === workerId); const job = document.jobs.find((item) => item.id === jobId);
    if (!worker || !job || job.leasedBy !== workerId || worker.activeJobId !== jobId) throw new Error('job lease ownership mismatch');
    job.status = success ? 'completed' : job.attempts < job.maxAttempts ? 'queued' : 'failed'; job.completedAt = success || job.status === 'failed' ? new Date().toISOString() : undefined; job.leasedBy = undefined; job.leasedAt = undefined;
    worker.activeJobId = undefined; worker.status = 'online'; worker.lastSeenAt = new Date().toISOString(); await this.save(document);
  }
}
