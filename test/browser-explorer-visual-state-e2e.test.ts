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

describe.skipIf(!enabled)('BrowserExplorer intentional UI state regression', () => {
  it('suppresses a controlled collapsed drawer but not an unrelated transformed visible defect', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><head><style>
        body { margin: 0; }
        #drawer { position: fixed; left: -340px; top: 60px; width: 300px; height: 300px; }
        #drawer a { display: block; width: 180px; height: 40px; }
        #gpu-layer { transform: translateZ(0); }
        #real-offscreen { position: fixed; left: 1500px; top: 120px; width: 140px; height: 40px; }
      </style></head><body>
        <button id="drawer-toggle" aria-controls="drawer" aria-expanded="false">Menu</button>
        <aside id="drawer"><a id="drawer-hidden" href="/hidden">Collapsed drawer link</a></aside>
        <div id="gpu-layer"><button id="real-offscreen">Real offscreen defect</button></div>
      </body></html>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const base = `http://127.0.0.1:${address.port}`;

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-browser-state-'));
    tempDirs.push(dir);
    const evidence = new EvidenceStore(dir, 'run');
    await evidence.init();
    const coverage = new CoverageGraph();
    const explorer = new BrowserExplorer(evidence, new QaPlanner(coverage), coverage);
    const options: QaRunOptions = {
      url: `${base}/`,
      maxActions: 1,
      maxDepth: 0,
      maxCandidatesPerPage: 4,
      headless: true,
      outputDir: dir,
      sameOriginOnly: true,
      riskMode: 'safe',
      visualViewports: ['desktop'],
      uxIntelligence: false,
    };

    const result = await explorer.run(options);
    const uiMessages = result.events.filter((event) => event.kind === 'ui').map((event) => event.message).join('\n');
    expect(uiMessages).not.toContain('Collapsed drawer link');
    expect(uiMessages).toContain('Real offscreen defect');
  }, 15_000);
});
