import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QaEvent } from '../src/core/types.js';
import {
  normalizeVisualRoute,
  VisualBaselineStore,
  visualBaselineEntryFromEvent,
} from '../src/visual/visual-baseline-store.js';

const tempDirs: string[] = [];

async function tempBaseline(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiqa-baseline-'));
  tempDirs.push(dir);
  return { dir, file: path.join(dir, 'visual.json') };
}

function visualEvent(element = 'button#save "Save 123"', url = 'https://example.com/users/123/settings'): QaEvent {
  return {
    timestamp: new Date().toISOString(),
    kind: 'ui',
    url,
    message: 'Visible text appears clipped: save 123 [viewport=mobile 390x844]',
    details: {
      visual: true,
      viewport: 'mobile',
      visualKind: 'text-clipping',
      severityHint: 'medium',
      element,
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('visual baseline store', () => {
  it('normalizes dynamic route identifiers', () => {
    expect(normalizeVisualRoute('https://example.com/users/123/orders/550e8400-e29b-41d4-a716-446655440000?tab=x'))
      .toBe('/users/:id/orders/:id');
  });

  it('produces stable keys across numeric content changes', () => {
    const first = visualBaselineEntryFromEvent(visualEvent('button#save "Save 123"'));
    const second = visualBaselineEntryFromEvent(visualEvent('button#save "Save 999"', 'https://example.com/users/999/settings'));
    expect(first?.key).toBe(second?.key);
  });

  it('treats signals as untracked before a baseline exists', async () => {
    const { file } = await tempBaseline();
    const store = new VisualBaselineStore(file);
    const comparison = await store.compare([visualEvent()]);
    expect(comparison.summary.existed).toBe(false);
    expect(comparison.summary.newSignals).toBe(0);
    expect(comparison.events[0]?.details?.baselineState).toBe('untracked');
  });

  it('tracks persistent, new and resolved visual signals', async () => {
    const { file } = await tempBaseline();
    const store = new VisualBaselineStore(file);
    const first = await store.compare([visualEvent()]);
    await store.save(first.current, 2);

    const persistent = await store.compare([visualEvent('button#save "Save 999"', 'https://example.com/users/999/settings')]);
    expect(persistent.summary.persistentSignals).toBe(1);
    expect(persistent.summary.newSignals).toBe(0);

    const changed = await store.compare([visualEvent('button#cancel "Cancel"')]);
    expect(changed.summary.newSignals).toBe(1);
    expect(changed.summary.resolvedSignals).toBe(1);
    expect(changed.events[0]?.details?.baselineState).toBe('new');
  });

  it('writes schema v3 analyzer provenance and allows a clean zero-signal baseline only after analysis ran', async () => {
    const { file } = await tempBaseline();
    const store = new VisualBaselineStore(file);

    await expect(store.save([], 0)).rejects.toThrow(/successfully analyzed visual state/i);
    await store.save([], 4);

    const manifest = JSON.parse(await readFile(file, 'utf8')) as { version?: number; analyzerVersion?: string; analyzedStates?: number; entries?: unknown[] };
    expect(manifest.version).toBe(3);
    expect(manifest.analyzerVersion).toBe('dom-geometry-v3');
    expect(manifest.analyzedStates).toBe(4);
    expect(manifest.entries).toEqual([]);
  });

  it('refuses to trust beta.5 v2 visual baselines after beta.6 classifier changes', async () => {
    const { file } = await tempBaseline();
    await writeFile(file, JSON.stringify({ version: 2, analyzerVersion: 'dom-geometry-v2', updatedAt: new Date().toISOString(), analyzedStates: 99, entries: [] }));
    const comparison = await new VisualBaselineStore(file).compare([visualEvent()]);
    expect(comparison.summary.existed).toBe(false);
    expect(comparison.summary.error).toMatch(/beta\.5 visual baseline/i);
    expect(comparison.events[0]?.details?.baselineState).toBe('untracked');
  });

  it('refuses to trust legacy beta.4 visual baselines after classifier changes', async () => {
    const { file } = await tempBaseline();
    await writeFile(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), analyzedStates: 99, entries: [] }));
    const comparison = await new VisualBaselineStore(file).compare([visualEvent()]);
    expect(comparison.summary.existed).toBe(false);
    expect(comparison.summary.error).toMatch(/legacy beta\.4 baseline/i);
    expect(comparison.events[0]?.details?.baselineState).toBe('untracked');
  });
});
