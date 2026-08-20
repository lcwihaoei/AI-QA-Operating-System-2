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

function pageHtml(pathname: string): string {
  if (pathname !== '/') return `<!doctype html><html><head><title>${pathname}</title></head><body><h1>${pathname}</h1><a href="/">Home</a></body></html>`;
  return `<!doctype html>
<html>
<head><title>QA fixture home</title></head>
<body>
  <h1>QA fixture</h1>
  <nav>
    <a href="/settings/profile">Settings profile</a>
    <a href="/settings/security">Settings security</a>
    <a href="/settings/privacy">Settings privacy</a>
    <a href="/settings/chat">Settings chat</a>
    <a href="/learning">Learning</a>
    <a href="/vocabulary">Vocabulary</a>
    <a href="/practice">Practice</a>
  </nav>
  <button id="menu" type="button" onclick="document.body.dataset.menuOpened='yes'">Open menu</button>
</body>
</html>`;
}

describe.skipIf(!enabled)('BrowserExplorer real Chromium regression', () => {
  it('covers multiple route families and performs a real safe button click', async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(pageHtml(url.pathname));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const base = `http://127.0.0.1:${address.port}`;

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-browser-e2e-'));
    tempDirs.push(dir);
    const evidence = new EvidenceStore(dir, 'run');
    await evidence.init();
    const coverage = new CoverageGraph();
    const explorer = new BrowserExplorer(evidence, new QaPlanner(coverage), coverage);
    const options: QaRunOptions = {
      url: `${base}/`,
      maxActions: 20,
      maxDepth: 1,
      maxCandidatesPerPage: 6,
      headless: true,
      outputDir: dir,
      sameOriginOnly: true,
      riskMode: 'standard',
      visualViewports: ['desktop'],
      uxIntelligence: false,
    };

    const result = await explorer.run(options);
    const paths = new Set(result.visitedUrls.map((value) => new URL(value).pathname));
    expect(paths.has('/learning')).toBe(true);
    expect(paths.has('/vocabulary')).toBe(true);
    expect(paths.has('/practice')).toBe(true);
    expect(result.events.some((event) => event.kind === 'action' && event.message === 'Click button: Open menu')).toBe(true);
    expect(result.events.some((event) => event.kind === 'planner' && Number(event.details?.selectedNavigation ?? 0) >= 3)).toBe(true);
    expect(result.events.some((event) => event.kind === 'planner' && Number(event.details?.selectedInteractions ?? 0) >= 1)).toBe(true);
    expect(result.uxSnapshots.length).toBeGreaterThanOrEqual(4);
  }, 15_000);
});
