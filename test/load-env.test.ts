import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../src/config/load-env.js';

const touched = ['MINIMAX_API_KEY', 'MINIMAX_MODEL', 'AIQA_VISUAL_ENDPOINT', 'AIQA_UX_ENDPOINT'];
const original = new Map(touched.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of touched) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('loadDotEnv', () => {
  it('loads MiniMax configuration from a local .env file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-env-'));
    const file = path.join(dir, '.env');
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_MODEL;
    await writeFile(file, 'MINIMAX_API_KEY=test-key\nMINIMAX_MODEL=minimax-m3\n');
    loadDotEnv(file);
    expect(process.env.MINIMAX_API_KEY).toBe('test-key');
    expect(process.env.MINIMAX_MODEL).toBe('minimax-m3');
  });

  it('does not override an already exported secret', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-env-'));
    const file = path.join(dir, '.env');
    process.env.MINIMAX_API_KEY = 'exported-key';
    await writeFile(file, 'MINIMAX_API_KEY=file-key\n');
    loadDotEnv(file);
    expect(process.env.MINIMAX_API_KEY).toBe('exported-key');
  });

  it('treats empty optional endpoint values as unset', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-env-'));
    const file = path.join(dir, '.env');
    delete process.env.AIQA_VISUAL_ENDPOINT;
    delete process.env.AIQA_UX_ENDPOINT;
    await writeFile(file, 'AIQA_VISUAL_ENDPOINT=\nAIQA_UX_ENDPOINT=""\n');
    loadDotEnv(file);
    expect(process.env.AIQA_VISUAL_ENDPOINT).toBeUndefined();
    expect(process.env.AIQA_UX_ENDPOINT).toBeUndefined();
  });
});
