import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UxExperimentResult } from './ux-experiment.js';

export type UxLearningStatus = 'untracked' | 'improved' | 'regressed' | 'stable';

interface UxBaseline {
  productKey: string;
  score: number;
  opportunityIds: string[];
  updatedAt: string;
}

interface StoredExperiment {
  productKey: string;
  controlId: string;
  winner?: string;
  generatedAt: string;
  recordedAt: string;
}

interface UxLearningDocument {
  version: 1;
  updatedAt: string;
  baselines: UxBaseline[];
  experiments: StoredExperiment[];
}

export interface UxLearningComparison {
  memoryExisted: boolean;
  status: UxLearningStatus;
  baselineScore?: number;
  currentScore: number;
  delta?: number;
}

const MAX_BYTES = 5_000_000;
const MAX_BASELINES = 500;
const MAX_EXPERIMENTS = 5_000;

function blank(): UxLearningDocument { return { version: 1, updatedAt: new Date().toISOString(), baselines: [], experiments: [] }; }
function safeProductKey(value: string): string {
  const key = value.trim().slice(0, 200);
  if (!/^[A-Za-z0-9._/@:-]+$/.test(key)) throw new Error('invalid UX product key');
  return key;
}
function valid(document: unknown): document is UxLearningDocument {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  const value = document as Record<string, unknown>;
  return value.version === 1 && Array.isArray(value.baselines) && value.baselines.length <= MAX_BASELINES
    && Array.isArray(value.experiments) && value.experiments.length <= MAX_EXPERIMENTS;
}

export class UxLearningStore {
  constructor(private readonly filePath = '.qa-memory/ux-learning.json') {}

  private async load(): Promise<{ existed: boolean; document: UxLearningDocument }> {
    try {
      const buffer = await readFile(this.filePath);
      if (buffer.length > MAX_BYTES) throw new Error('UX learning memory exceeds 5 MB');
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
      if (!valid(parsed)) throw new Error('UX learning memory has unsupported schema');
      return { existed: true, document: parsed };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { existed: false, document: blank() };
      throw error;
    }
  }

  async compare(productKey: string, currentScore: number): Promise<UxLearningComparison> {
    const key = safeProductKey(productKey);
    if (!Number.isFinite(currentScore) || currentScore < 0 || currentScore > 100) throw new Error('UX score must be 0-100');
    const loaded = await this.load();
    const baseline = loaded.document.baselines.find((item) => item.productKey === key);
    if (!baseline) return { memoryExisted: loaded.existed, status: 'untracked', currentScore };
    const delta = Math.round((currentScore - baseline.score) * 10) / 10;
    return {
      memoryExisted: loaded.existed,
      status: delta >= 5 ? 'improved' : delta <= -5 ? 'regressed' : 'stable',
      baselineScore: baseline.score,
      currentScore,
      delta,
    };
  }

  async saveBaseline(productKey: string, score: number, opportunityIds: string[]): Promise<void> {
    const key = safeProductKey(productKey);
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('UX score must be 0-100');
    const loaded = await this.load();
    const baseline: UxBaseline = {
      productKey: key, score, opportunityIds: [...new Set(opportunityIds)].slice(0, 500), updatedAt: new Date().toISOString(),
    };
    loaded.document.baselines = [...loaded.document.baselines.filter((item) => item.productKey !== key), baseline].slice(-MAX_BASELINES);
    await this.save(loaded.document);
  }

  async recordExperiment(productKey: string, result: UxExperimentResult): Promise<void> {
    const key = safeProductKey(productKey);
    const loaded = await this.load();
    loaded.document.experiments.push({
      productKey: key, controlId: result.controlId.slice(0, 100), winner: result.winner?.slice(0, 100), generatedAt: result.generatedAt, recordedAt: new Date().toISOString(),
    });
    loaded.document.experiments = loaded.document.experiments.slice(-MAX_EXPERIMENTS);
    await this.save(loaded.document);
  }

  private async save(document: UxLearningDocument): Promise<void> {
    document.updatedAt = new Date().toISOString();
    await mkdir(path.dirname(path.resolve(this.filePath)), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
