import { createServer } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserExplorer } from '../src/agents/browser-explorer.js';
import type { QaRunOptions } from '../src/core/types.js';
import { EvidenceStore } from '../src/evidence/evidence-store.js';
import { CoverageGraph } from '../src/planning/coverage-graph.js';
import { QaPlanner } from '../src/planning/qa-planner.js';

const enabled = process.env.AIQA_BROWSER_E2E === '1';
const servers: Array<ReturnType<typeof createServer>> = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function serverFor(body: string): Promise<string> {
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><body>${body}</body></html>`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
  return `http://127.0.0.1:${address.port}/`;
}

async function run(url: string, maxActions = 3) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-beta10-browser-contract-'));
  dirs.push(dir);
  const evidence = new EvidenceStore(dir, 'run');
  await evidence.init();
  const coverage = new CoverageGraph();
  const explorer = new BrowserExplorer(evidence, new QaPlanner(coverage), coverage);
  const options: QaRunOptions = {
    url,
    maxActions,
    maxDepth: 1,
    maxCandidatesPerPage: 8,
    headless: true,
    outputDir: dir,
    sameOriginOnly: true,
    riskMode: 'standard',
    visualViewports: ['desktop'],
    uxIntelligence: false,
  };
  return explorer.run(options);
}

describe.skipIf(!enabled)('BrowserExplorer Beta.10 identity/evidence contracts', () => {
  it('distinguishes same-label controls by their stable owning dialog', async () => {
    const url = await serverFor(`
      <section role="dialog" id="profile-dialog"><button type="button">Save</button></section>
      <section role="dialog" id="settings-dialog"><button type="button">Save</button></section>
    `);
    const result = await run(url, 2);
    const ranked = result.events.find((event) => event.kind === 'planner' && event.message.startsWith('Planner ranked'));
    const top = (ranked?.details?.top ?? []) as Array<{ id?: string; label?: string }>;
    const saveIds = top.filter((item) => item.label === 'Save').map((item) => item.id ?? '');
    expect(saveIds.some((id) => id.includes('owner=id=profile-dialog'))).toBe(true);
    expect(saveIds.some((id) => id.includes('owner=id=settings-dialog'))).toBe(true);
    expect(new Set(saveIds).size).toBe(2);
  }, 15_000);

  it('attaches same-state screenshot evidence when BrowserExplorer emits a UI signal', async () => {
    const url = await serverFor(`
      <style>#broken { position:absolute; left:1700px; top:20px; width:120px; height:40px; }</style>
      <button id="broken" type="button">Broken offscreen action</button>
    `);
    const result = await run(url, 1);
    const signal = result.events.find((event) => event.kind === 'ui' && event.details?.browserUi === true);
    expect(signal?.details?.uiKind).toBe('interactive-offscreen');
    expect(typeof signal?.details?.interactionStateId).toBe('string');
    expect(typeof signal?.details?.screenshot).toBe('string');
    await expect(access(String(signal?.details?.screenshot))).resolves.toBeUndefined();
    expect(signal?.details?.screenshotUnavailableReason).toBeUndefined();
  }, 15_000);
});
