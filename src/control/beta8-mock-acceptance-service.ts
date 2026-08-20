import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MockMigrationProposal } from '../backend/mock-migration-executor.js';
import {
  LocalGitMockMigrationAcceptance,
  type MockMigrationAcceptancePreview,
  type MockMigrationAcceptanceRecord,
  type MockMigrationExecutionEvidence,
} from '../backend/mock-migration-acceptance.js';

const MAX_JSON_BYTES = 50_000_000;

interface MainMockItemState {
  latestProposal?: { file: string; summary: { proposalHash: string } };
  latestExecution?: { file: string; verified: boolean; rolledBack: boolean; branch?: string; error?: string };
}
interface MainMockState { schemaVersion: 1; items: Record<string, MainMockItemState> }

interface AcceptanceItemState {
  preview?: MockMigrationAcceptancePreview;
  record?: MockMigrationAcceptanceRecord;
  recordFile?: string;
  message?: string;
}
interface AcceptanceState {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, AcceptanceItemState>;
}

export interface Beta8MockAcceptanceSummary {
  available: boolean;
  items: Record<string, {
    preview?: MockMigrationAcceptancePreview;
    record?: Pick<MockMigrationAcceptanceRecord, 'acceptanceHash' | 'acceptedAt' | 'acceptedBy' | 'commitSha' | 'branch' | 'proposalHash' | 'changedFiles'>;
    message?: string;
  }>;
  error?: string;
}

function bounded(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function safeArtifactId(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
  if (!safe) throw new Error('mock acceptance id cannot produce a safe artifact name');
  return safe;
}

async function readBoundedJson<T>(filePath: string): Promise<T> {
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_JSON_BYTES) throw new Error('Beta.8 mock acceptance artifact exceeds size limit');
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
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error(`immutable Beta.8 mock acceptance record already exists: ${path.basename(filePath)}`);
    throw error;
  }
}

export class Beta8MockAcceptanceDashboardService {
  private readonly artifactRoot: string;
  private readonly mainStatePath: string;
  private readonly statePath: string;

  constructor(private readonly repoPath: string, artifactRoot = '.qa-backend') {
    this.artifactRoot = path.resolve(artifactRoot);
    this.mainStatePath = path.join(this.artifactRoot, 'dashboard-mock-state.json');
    this.statePath = path.join(this.artifactRoot, 'dashboard-mock-acceptance-state.json');
  }

  private async state(): Promise<AcceptanceState> {
    try {
      const state = await readBoundedJson<AcceptanceState>(this.statePath);
      if (state.schemaVersion !== 1 || !state.items || typeof state.items !== 'object') throw new Error('invalid Beta.8 mock acceptance state');
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

  private async evidence(recordId: string): Promise<{ proposal: MockMigrationProposal; execution: MockMigrationExecutionEvidence }> {
    const main = await readBoundedJson<MainMockState>(this.mainStatePath);
    const item = main.items?.[recordId];
    if (!item?.latestProposal?.file || !item.latestExecution?.file) throw new Error('mock acceptance requires a completed dashboard proposal and immutable execution record');
    if (!item.latestExecution.verified || item.latestExecution.rolledBack) throw new Error('mock acceptance requires the latest migration execution to be verified');
    const [proposal, execution] = await Promise.all([
      readBoundedJson<MockMigrationProposal>(item.latestProposal.file),
      readBoundedJson<MockMigrationExecutionEvidence>(item.latestExecution.file),
    ]);
    if (proposal.proposalHash !== item.latestProposal.summary.proposalHash) throw new Error('mock acceptance proposal metadata is stale');
    return { proposal, execution };
  }

  async summary(): Promise<Beta8MockAcceptanceSummary> {
    try {
      const state = await this.state();
      const items: Beta8MockAcceptanceSummary['items'] = {};
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

  async preview(recordId: string): Promise<Beta8MockAcceptanceSummary> {
    const { proposal, execution } = await this.evidence(recordId);
    const preview = await new LocalGitMockMigrationAcceptance(this.repoPath).preview(recordId, proposal, execution);
    const state = await this.state();
    const current = state.items[recordId] ?? {};
    current.preview = preview;
    current.message = 'Verified mock migration tree inspected. Review exact file hashes and acceptance hash before creating a local commit.';
    state.items[recordId] = current;
    await this.save(state);
    return this.summary();
  }

  async accept(recordId: string, confirmAcceptanceHash: string, acceptedBy: string): Promise<Beta8MockAcceptanceSummary> {
    const { proposal, execution } = await this.evidence(recordId);
    const acceptance = new LocalGitMockMigrationAcceptance(this.repoPath);
    const record = await acceptance.accept({ recordId, proposal, execution, confirmAcceptanceHash, acceptedBy });
    const safe = safeArtifactId(recordId);
    const file = path.join(this.artifactRoot, 'mock-acceptances', `${safe}-${record.acceptanceHash.slice(0, 12)}.json`);
    await writeImmutableJson(file, record);
    const state = await this.state();
    state.items[recordId] = {
      preview: record,
      record,
      recordFile: file,
      message: `Verified mock migration accepted as local commit ${record.commitSha}. No push or merge was performed.`,
    };
    await this.save(state);
    return this.summary();
  }
}
