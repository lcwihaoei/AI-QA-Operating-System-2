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
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!enabled)('BrowserExplorer clickability preflight integration', () => {
  it('records pointer interception as an explained eligible gap without emitting a product page-error', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><head><style>
        body { margin: 0; }
        #covered { position: fixed; left: 100px; top: 100px; width: 180px; height: 44px; }
        #overlay { position: fixed; left: 80px; top: 80px; width: 240px; height: 100px; z-index: 5; }
      </style></head><body>
        <button id="covered" type="button">Covered action</button>
        <div id="overlay">Transient overlay</div>
      </body></html>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address unavailable');

    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-clickability-explorer-'));
    dirs.push(outputDir);
    const evidence = new EvidenceStore(outputDir, 'run');
    await evidence.init();
    const coverage = new CoverageGraph();
    const explorer = new BrowserExplorer(evidence, new QaPlanner(coverage), coverage);
    const options: QaRunOptions = {
      url: `http://127.0.0.1:${address.port}/`,
      maxActions: 5,
      maxDepth: 0,
      maxCandidatesPerPage: 4,
      headless: true,
      outputDir,
      sameOriginOnly: true,
      riskMode: 'safe',
      visualViewports: ['desktop'],
      uxIntelligence: false,
    };

    const result = await explorer.run(options);
    const preflightSkip = result.events.find((event) =>
      event.kind === 'action' && event.details?.clickabilityPreflight === true && event.details?.gapReason === 'pointer-intercepted');
    expect(preflightSkip?.message).toContain('Covered action');
    expect(result.events.some((event) => event.kind === 'page-error' && event.message.startsWith('Button probe failed:'))).toBe(false);

    const snapshot = coverage.snapshot();
    expect(snapshot.gapReasonCounts?.['pointer-intercepted']).toBe(1);
    expect(snapshot.explainedEligibleGaps).toBe(1);
    expect(snapshot.unexplainedEligibleGaps).toBe(0);
    expect(snapshot.eligibleInteractionCoverage).toBe(0);
  }, 15_000);
});
