import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Finding } from '../core/types.js';

const findingSchema = z.object({
  id: z.string(),
  kind: z.enum(['console', 'page-error', 'network', 'ui', 'navigation', 'assertion']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string(), url: z.string(), message: z.string(), reproduction: z.array(z.string()), evidence: z.array(z.string()), fingerprint: z.string(),
});
const resultSchema = z.object({ findings: z.array(findingSchema).max(20_000) });

export async function loadFindingInput(options: { findingPath?: string; resultPath?: string; fingerprint?: string }): Promise<Finding> {
  if (Boolean(options.findingPath) === Boolean(options.resultPath)) throw new Error('provide exactly one of --finding or --result');
  if (options.findingPath) return findingSchema.parse(JSON.parse(await readFile(options.findingPath, 'utf8'))) as Finding;
  if (!options.fingerprint) throw new Error('--result requires --fingerprint');
  const result = resultSchema.parse(JSON.parse(await readFile(options.resultPath!, 'utf8')));
  const finding = result.findings.find((item) => item.fingerprint === options.fingerprint);
  if (!finding) throw new Error(`fingerprint ${options.fingerprint} was not found in the QA result`);
  return finding as Finding;
}
