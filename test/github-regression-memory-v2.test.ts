import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding } from '../src/core/types.js';
import { GitHubRegressionMemoryStore } from '../src/github/github-regression-memory.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-gh-memory-'));
  dirs.push(dir);
  return path.join(dir, 'memory.json');
}

const finding: Finding = {
  id: 'BUG-0001',
  kind: 'ui',
  severity: 'medium',
  title: 'Example finding',
  url: 'https://example.com/settings',
  message: 'Example finding',
  reproduction: ['Open settings'],
  evidence: [],
  fingerprint: 'abc123',
};

describe('GitHub regression memory beta.6 classifier boundary', () => {
  it('writes versioned finding-v2 memory with beta.6 classifier provenance', async () => {
    const file = await tempFile();
    const store = new GitHubRegressionMemoryStore(file);
    await store.save([finding], new Map());
    const document = JSON.parse(await readFile(file, 'utf8')) as { version?: number; fingerprintSchema?: string; classifierVersion?: string };
    expect(document.version).toBe(3);
    expect(document.fingerprintSchema).toBe('finding-v2');
    expect(document.classifierVersion).toBe('qa-engine-beta6');
    const loaded = await store.load();
    expect(loaded.entries.has('abc123')).toBe(true);
  });

  it('does not trust beta.5 v2 memory after beta.6 classifier changes', async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ version: 2, fingerprintSchema: 'finding-v2', updatedAt: new Date().toISOString(), findings: [] }));
    const loaded = await new GitHubRegressionMemoryStore(file).load();
    expect(loaded.entries.size).toBe(0);
    expect(loaded.toolingError).toMatch(/beta\.5/i);
  });

  it('does not trust beta.4 v1 memory after classifier changes', async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), findings: [] }));
    const loaded = await new GitHubRegressionMemoryStore(file).load();
    expect(loaded.entries.size).toBe(0);
    expect(loaded.toolingError).toMatch(/beta\.4/i);
  });
});
