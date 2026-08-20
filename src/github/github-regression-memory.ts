import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding, Severity } from '../core/types.js';

interface MemoryEntry {
  fingerprint: string;
  severity: Severity;
  kind: string;
  title: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
}

interface MemoryDocument {
  version: 2;
  fingerprintSchema: 'finding-v2';
  updatedAt: string;
  findings: MemoryEntry[];
}

export interface LoadedGitHubRegressionMemory {
  existed: boolean;
  entries: Map<string, MemoryEntry>;
  toolingError?: string;
}

const SEVERITIES = new Set<Severity>(['critical', 'high', 'medium', 'low', 'info']);
const MAX_MEMORY_BYTES = 5_000_000;
const MAX_ENTRIES = 20_000;

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return typeof source.fingerprint === 'string'
    && source.fingerprint.length > 0
    && source.fingerprint.length <= 100
    && typeof source.severity === 'string'
    && SEVERITIES.has(source.severity as Severity)
    && typeof source.kind === 'string'
    && source.kind.length <= 100
    && typeof source.title === 'string'
    && source.title.length <= 500
    && typeof source.firstSeenAt === 'string'
    && typeof source.lastSeenAt === 'string'
    && typeof source.occurrences === 'number'
    && Number.isInteger(source.occurrences)
    && source.occurrences >= 1;
}

export class GitHubRegressionMemoryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<LoadedGitHubRegressionMemory> {
    try {
      const buffer = await readFile(this.filePath);
      if (buffer.length > MAX_MEMORY_BYTES) {
        return { existed: true, entries: new Map(), toolingError: 'GitHub regression memory exceeds 5 MB' };
      }
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { existed: true, entries: new Map(), toolingError: 'GitHub regression memory is not a JSON object' };
      }
      const source = parsed as Record<string, unknown>;
      if (source.version !== 2 || source.fingerprintSchema !== 'finding-v2' || !Array.isArray(source.findings) || source.findings.length > MAX_ENTRIES) {
        const legacy = source.version === 1
          ? 'GitHub regression memory is from beta.4 and must be explicitly regenerated for finding-v2 fingerprints'
          : 'GitHub regression memory has an unsupported or oversized schema';
        return { existed: true, entries: new Map(), toolingError: legacy };
      }
      const entries = new Map<string, MemoryEntry>();
      for (const item of source.findings) {
        if (!isMemoryEntry(item)) {
          return { existed: true, entries: new Map(), toolingError: 'GitHub regression memory contains an invalid entry' };
        }
        if (!entries.has(item.fingerprint)) entries.set(item.fingerprint, item);
      }
      return { existed: true, entries };
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return { existed: false, entries: new Map() };
      return { existed: false, entries: new Map(), toolingError: String(error) };
    }
  }

  async save(findings: Finding[], prior: Map<string, MemoryEntry>): Promise<void> {
    const now = new Date().toISOString();
    const deduped = new Map(findings.map((finding) => [finding.fingerprint, finding]));
    const entries: MemoryEntry[] = [...deduped.values()].slice(0, MAX_ENTRIES).map((finding) => {
      const previous = prior.get(finding.fingerprint);
      return {
        fingerprint: finding.fingerprint,
        severity: finding.severity,
        kind: finding.kind,
        title: finding.title.slice(0, 500),
        firstSeenAt: previous?.firstSeenAt ?? now,
        lastSeenAt: now,
        occurrences: Math.min((previous?.occurrences ?? 0) + 1, Number.MAX_SAFE_INTEGER),
      };
    });
    const document: MemoryDocument = { version: 2, fingerprintSchema: 'finding-v2', updatedAt: now, findings: entries };
    await mkdir(path.dirname(path.resolve(this.filePath)), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
