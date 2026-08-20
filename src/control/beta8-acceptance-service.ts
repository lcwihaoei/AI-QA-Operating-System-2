import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BackendExecutionAttemptRecord, BackendTaskProposal } from '../backend/executor-types.js';
import { LocalGitBackendTaskAcceptance, type Beta8AcceptancePreview, type Beta8AcceptanceRecord } from '../backend/backend-task-acceptance.js';

const MAX_JSON_BYTES = 50_000_000;

interface MainTaskState {
  latestProposal?: { file: string; summary: { proposalHash: string } };
  latestAttempt?: { file: string; outcome: string; branch?: string; error?: string };
}
interface MainActionState { schemaVersion: 1; items: Record<string, MainTaskState> }

interface AcceptanceItemState {
  preview?: Beta8AcceptancePreview;
  record?: Beta8AcceptanceRecord;
  recordFile?: string;
  message?: string;
}
interface AcceptanceState {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, AcceptanceItemState>;
}

export interface Beta8AcceptanceSummary {
  available: boolean;
  items: Record<string, {
    preview?: Beta8AcceptancePreview;
    record?: Pick<Beta8AcceptanceRecord, 'acceptanceHash' | 'acceptedAt' | 'acceptedBy' | 'commitSha' | 'branch' | 'proposalHash' | 'changedFiles'>;
    message?: string;
  }>;
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

async function readBoundedJson<T>(filePath: string): Promise<T> {
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_JSON_BYTES) throw new Error('Beta.8 acceptance artifact exceeds size limit');
  return JSON.parse(buffer.toString('utf8')) as T;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error(`immutable Beta.8 acceptance record already exists: ${path.basename(filePath)}`);
    throw error;
  }
}

export class Beta8AcceptanceDashboardService {
  private readonly artifactRoot: string;
  private readonly mainStatePath: string;
  private readonly statePath: string;

  constructor(private readonly repoPath: string, artifactRoot = '.qa-backend') {
    this.artifactRoot = path.resolve(artifactRoot);
    this.mainStatePath = path.join(this.artifactRoot, 'dashboard-action-state.json');
    this.statePath = path.join(this.artifactRoot, 'dashboard-acceptance-state.json');
  }

  private async state(): Promise<AcceptanceState> {
    try {
      const state = await readBoundedJson<AcceptanceState>(this.statePath);
      if (state.schemaVersion !== 1 || !state.items || typeof state.items !== 'object') throw new Error('invalid Beta.8 acceptance state');
      return state;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { schemaVersion: 1, updatedAt: new Date().toISOString(), items: {} };
      throw error;
    }
  }

  private async save(state: AcceptanceState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await writePrivateJson(this.statePath, state);
  }

  private async evidence(itemId: string): Promise<{ proposal: BackendTaskProposal; attempt: BackendExecutionAttemptRecord }> {
    const main = await readBoundedJson<MainActionState>(this.mainStatePath);
    const item = main.items?.[itemId];
    if (!item?.latestProposal?.file || !item.latestAttempt?.file) throw new Error('Beta.8 acceptance requires a completed dashboard proposal and immutable attempt record');
    if (item.latestAttempt.outcome !== 'verified') throw new Error('Beta.8 acceptance requires the latest task attempt to be verified');
    const [proposal, attempt] = await Promise.all([
      readBoundedJson<BackendTaskProposal>(item.latestProposal.file),
      readBoundedJson<BackendExecutionAttemptRecord>(item.latestAttempt.file),
    ]);
    if (proposal.proposalHash !== item.latestProposal.summary.proposalHash) throw new Error('Beta.8 acceptance proposal metadata is stale');
    return { proposal, attempt };
  }

  async summary(): Promise<Beta8AcceptanceSummary> {
    try {
      const state = await this.state();
      const items: Beta8AcceptanceSummary['items'] = {};
      for (const [id, item] of Object.entries(state.items)) {
        items[id] = {
          ...(item.preview ? { preview: item.preview } : {}),
          ...(item.record ? { record: {
            acceptanceHash: item.record.acceptanceHash,
            acceptedAt: item.record.acceptedAt,
            acceptedBy: item.record.acceptedBy,
            commitSha: item.record.commitSha,
            branch: item.record.branch,
            proposalHash: item.record.proposalHash,
            changedFiles: item.record.changedFiles,
          } } : {}),
          ...(item.message ? { message: bounded(item.message, 1_000) } : {}),
        };
      }
      return { available: true, items };
    } catch (error: unknown) {
      return { available: false, items: {}, error: bounded(error instanceof Error ? error.message : error, 1_000) };
    }
  }

  async preview(itemId: string): Promise<Beta8AcceptanceSummary> {
    const { proposal, attempt } = await this.evidence(itemId);
    const preview = await new LocalGitBackendTaskAcceptance(this.repoPath).preview(itemId, proposal, attempt);
    const state = await this.state();
    const current = state.items[itemId] ?? {};
    current.preview = preview;
    current.message = 'Verified tree inspected. Review the exact file hashes and acceptance hash before creating a local commit.';
    state.items[itemId] = current;
    await this.save(state);
    return this.summary();
  }

  async accept(itemId: string, confirmAcceptanceHash: string, acceptedBy: string): Promise<Beta8AcceptanceSummary> {
    const { proposal, attempt } = await this.evidence(itemId);
    const acceptance = new LocalGitBackendTaskAcceptance(this.repoPath);
    const record = await acceptance.accept({ itemId, proposal, attempt, confirmAcceptanceHash, acceptedBy });
    const safe = safeArtifactId(itemId);
    const file = path.join(this.artifactRoot, 'acceptances', `${safe}-${record.acceptanceHash.slice(0, 12)}.json`);
    await writeImmutableJson(file, record);
    const state = await this.state();
    state.items[itemId] = {
      preview: record,
      record,
      recordFile: file,
      message: `Verified task accepted as local commit ${record.commitSha}. No push or merge was performed.`,
    };
    await this.save(state);
    return this.summary();
  }
}
