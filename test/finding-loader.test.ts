import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFindingInput } from '../src/fix/finding-loader.js';

const finding = { id: 'BUG-1', kind: 'assertion', severity: 'high', title: 'Broken', url: 'https://x.test', message: 'broken', reproduction: [], evidence: [], fingerprint: 'abc123' };

describe('M7 finding handoff', () => {
  it('selects a finding directly from QA result.json by fingerprint', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-finding-'));
    const file = path.join(dir, 'result.json');
    await writeFile(file, JSON.stringify({ findings: [finding] }));
    await expect(loadFindingInput({ resultPath: file, fingerprint: 'abc123' })).resolves.toMatchObject({ fingerprint: 'abc123', title: 'Broken' });
  });

  it('refuses ambiguous input sources and missing fingerprints', async () => {
    await expect(loadFindingInput({})).rejects.toThrow(/exactly one/);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-finding-'));
    const file = path.join(dir, 'result.json');
    await writeFile(file, JSON.stringify({ findings: [finding] }));
    await expect(loadFindingInput({ resultPath: file })).rejects.toThrow(/fingerprint/);
  });
});
