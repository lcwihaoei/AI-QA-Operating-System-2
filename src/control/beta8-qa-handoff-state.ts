import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(500),
  resultPath: z.string().min(1).max(10_000),
});

export async function loadBeta8QaHandoffResultPath(input: { artifactRoot: string; repoPath: string }): Promise<string | undefined> {
  const artifactRoot = path.resolve(input.artifactRoot);
  const repoRoot = path.resolve(input.repoPath);
  try {
    const statePath = path.join(artifactRoot, 'final-qa-handoff.json');
    const stat = await lstat(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Beta.8 final QA handoff state must be a regular file');
    const buffer = await readFile(statePath);
    if (buffer.length > 5_000_000) throw new Error('Beta.8 final QA handoff state exceeds size limit');
    const state = stateSchema.parse(JSON.parse(buffer.toString('utf8')));
    const result = path.resolve(state.resultPath);
    const relative = path.relative(repoRoot, result);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Beta.8 final QA result escaped the configured target repository');
    const resultStat = await lstat(result);
    if (!resultStat.isFile() || resultStat.isSymbolicLink()) throw new Error('Beta.8 final QA result must be a regular file');
    return result;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}
