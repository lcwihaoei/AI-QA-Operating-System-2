import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceStore } from '../src/evidence/evidence-store.js';

const roots: string[] = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('EvidenceStore device screenshots', () => {
  it('writes validated base64 PNG evidence into the run screenshot directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiqa-device-'));
    roots.push(root);
    const store = new EvidenceStore(root, 'run-1');
    await store.init();
    const file = await store.writePngBase64(png, 'device-ios-smoke');
    const bytes = await readFile(file);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(file).toContain(path.join('run-1', 'screenshots'));
  });

  it('rejects non-PNG base64 payloads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiqa-device-'));
    roots.push(root);
    const store = new EvidenceStore(root, 'run-2');
    await store.init();
    await expect(store.writePngBase64(Buffer.from('not a png').toString('base64'), 'bad')).rejects.toThrow(/not a PNG/);
  });
});
