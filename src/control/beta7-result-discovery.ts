import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const MAX_STATE_BYTES = 5_000_000;
const MAX_ATTEMPT_BYTES = 5_000_000;
const MAX_RESULT_BYTES = 50_000_000;
const MAX_RUN_DIRECTORIES = 10_000;

const resultSchema = z.object({
  runId: z.string().min(1).max(500),
  findings: z.array(z.unknown()).max(20_000),
});

const attemptSchema = z.object({
  schemaVersion: z.literal(1),
  workItemId: z.string().min(1).max(120),
  attempt: z.number().int().min(1).max(100),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  outcome: z.enum(['awaiting-correlation', 'verified', 'rejected', 'rolled-back']),
});

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.record(z.string(), z.object({
    latestAttempt: z.object({
      file: z.string().min(1).max(5_000),
      attempt: z.number().int().min(1).max(100),
      outcome: z.string().max(100),
    }).optional(),
  }).passthrough()),
}).passthrough();

async function readBoundedJson(filePath: string, maxBytes: number): Promise<unknown> {
  const buffer = await readFile(filePath);
  if (buffer.length > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes: ${path.basename(filePath)}`);
  return JSON.parse(buffer.toString('utf8')) as unknown;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export interface Beta7PostResultDiscoveryInput {
  runsRoot: string;
  artifactRoot: string;
  sourceResultPath: string;
  sourceRunId: string;
  itemId: string;
}

export interface Beta7PostResultDiscovery {
  path: string;
  runId: string;
  attempt: number;
  attemptStartedAt: string;
}

export async function discoverFreshBeta7Result(input: Beta7PostResultDiscoveryInput): Promise<Beta7PostResultDiscovery> {
  const artifactRoot = path.resolve(input.artifactRoot);
  const runsRoot = path.resolve(input.runsRoot);
  const statePath = path.join(artifactRoot, 'dashboard-action-state.json');
  const state = stateSchema.parse(await readBoundedJson(statePath, MAX_STATE_BYTES));
  const latestAttempt = state.items[input.itemId]?.latestAttempt;
  if (!latestAttempt) throw new Error('fresh Beta.7 auto-discovery requires a recorded Beta.9 attempt');

  const attemptPath = path.resolve(latestAttempt.file);
  if (!inside(artifactRoot, attemptPath)) throw new Error('Beta.9 attempt record escaped the configured artifact root');
  const attemptStat = await lstat(attemptPath);
  if (!attemptStat.isFile() || attemptStat.isSymbolicLink()) throw new Error('Beta.9 attempt record must be a regular file');
  const attempt = attemptSchema.parse(await readBoundedJson(attemptPath, MAX_ATTEMPT_BYTES));
  if (attempt.workItemId !== input.itemId || attempt.attempt !== latestAttempt.attempt) throw new Error('Beta.9 attempt record does not match dashboard state');
  if (!['awaiting-correlation', 'verified'].includes(attempt.outcome)) throw new Error('Beta.9 attempt is not eligible for fresh-result correlation');

  const startedAtMs = Date.parse(attempt.startedAt);
  if (!Number.isFinite(startedAtMs)) throw new Error('Beta.9 attempt start time is invalid');

  const sourcePath = path.resolve(input.sourceResultPath);
  const entries = await readdir(runsRoot, { withFileTypes: true });
  if (entries.length > MAX_RUN_DIRECTORIES) throw new Error(`Beta.7 run root exceeds ${MAX_RUN_DIRECTORIES} entries; specify --beta9-post-result explicitly`);

  const candidates: Array<{ path: string; runId: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.resolve(runsRoot, entry.name, 'result.json');
    if (!inside(runsRoot, candidate) || candidate === sourcePath) continue;
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      // The result is written during the attempt, before the executor records finishedAt.
      // Requiring it to be newer than attempt.startedAt avoids selecting arbitrary old runs.
      if (stat.mtimeMs + 1_000 < startedAtMs) continue;
      const parsed = resultSchema.parse(await readBoundedJson(candidate, MAX_RESULT_BYTES));
      if (parsed.runId === input.sourceRunId) continue;
      candidates.push({ path: candidate, runId: parsed.runId, mtimeMs: stat.mtimeMs });
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      // Invalid files are ignored as candidates instead of being trusted as QA evidence.
      if (error instanceof z.ZodError || error instanceof SyntaxError) continue;
      throw error;
    }
  }

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  if (candidates.length === 0) throw new Error('no fresh Beta.7 result was found after the selected Beta.9 attempt started');
  if (candidates.length > 1) {
    throw new Error(`multiple fresh Beta.7 results (${candidates.length}) match this attempt; specify --beta9-post-result explicitly instead of guessing`);
  }
  return {
    path: candidates[0]!.path,
    runId: candidates[0]!.runId,
    attempt: attempt.attempt,
    attemptStartedAt: attempt.startedAt,
  };
}
