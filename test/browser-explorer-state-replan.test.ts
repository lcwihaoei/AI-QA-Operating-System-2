import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><title>State replan fixture</title></head><body>
      <main id="root">
        <h1>State replan fixture</h1>
        <button id="open-panel" type="button">Open panel</button>
      </main>
      <script>
        document.getElementById('open-panel').addEventListener('click', () => {
          const root = document.getElementById('root');
          document.getElementById('open-panel').remove();

          const panelAction = document.createElement('button');
          panelAction.id = 'panel-action';
          panelAction.type = 'button';
          panelAction.textContent = 'Panel action';
          panelAction.addEventListener('click', () => { document.body.dataset.panelAction = 'done'; });
          root.prepend(panelAction);

          const lateAction = document.createElement('button');
          lateAction.id = 'late-action';
          lateAction.type = 'button';
          lateAction.textContent = 'Late action';
          lateAction.addEventListener('click', () => { document.body.dataset.lateAction = 'done'; });
          root.append(lateAction);
        });
      </script>
    </body></html>`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
  return `http://127.0.0.1:${address.port}/`;
}

async function run(url: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-state-replan-'));
  tempDirs.push(dir);
  const evidence = new EvidenceStore(dir, 'run');
  await evidence.init();
  const coverage = new CoverageGraph();
  const explorer = new BrowserExplorer(evidence, new QaPlanner(coverage), coverage);
  const options: QaRunOptions = {
    url,
    maxActions: 8,
    maxDepth: 1,
    maxCandidatesPerPage: 6,
    headless: true,
    outputDir: dir,
    sameOriginOnly: true,
    riskMode: 'standard',
    visualViewports: ['desktop'],
    uxIntelligence: false,
  };
  return explorer.run(options);
}

describe.skipIf(!enabled)('BrowserExplorer state-aware replanning', () => {
  it('invalidates stale locator-index plans and discovers controls created by the new UI state', async () => {
    const result = await run(await fixture());
    const actionMessages = result.events.filter((event) => event.kind === 'action').map((event) => event.message);

    expect(actionMessages).toContain('Click button: Open panel');
    expect(actionMessages).toContain('Click button: Panel action');
    expect(result.events.some((event) => event.kind === 'planner' && event.details?.stateReplan === true)).toBe(true);
    expect(result.events.some((event) => event.kind === 'page-error' && event.message.startsWith('Button probe failed:'))).toBe(false);

    const plannerRounds = result.events
      .filter((event) => event.kind === 'planner' && event.message.startsWith('Planner ranked'))
      .map((event) => Number(event.details?.interactionRound ?? 0));
    expect(Math.max(...plannerRounds)).toBeGreaterThanOrEqual(2);
  }, 15_000);
});
