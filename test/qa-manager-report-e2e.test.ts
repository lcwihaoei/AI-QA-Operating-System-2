import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QaManager } from '../src/core/qa-manager.js';

const enabled = process.env.AIQA_BROWSER_E2E === '1';
const servers: Array<ReturnType<typeof createServer>> = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!enabled)('QaManager beta7 evidence report E2E', () => {
  it('produces a self-contained report bundle with a real screenshot, viewport video, and lossless finding clusters', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><head><title>Report fixture</title><style>
        body { margin: 0; font-family: sans-serif; }
        .clip { width: 90px; height: 18px; overflow: hidden; white-space: nowrap; }
      </style></head><body>
        <h1>Evidence report fixture</h1>
        <p class="clip">This visible sentence is intentionally too long for its test box.</p>
        <button type="button">Safe action</button>
      </body></html>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-manager-report-'));
    dirs.push(outputDir);
    const result = await new QaManager().run({
      url: `http://127.0.0.1:${address.port}/`,
      maxActions: 4,
      maxDepth: 0,
      maxCandidatesPerPage: 2,
      headless: true,
      outputDir,
      sameOriginOnly: true,
      riskMode: 'safe',
      visualViewports: ['mobile'],
      apiMode: 'off',
      semanticState: false,
      deviceMode: 'off',
      githubQa: false,
      uxIntelligence: false,
      evidenceReport: true,
      recordVideo: true,
    });

    expect(result.findings.some((finding) => finding.title === 'Visible text is clipped')).toBe(true);
    expect(result.findingClusters?.rawFindings).toBe(result.findings.length);
    expect(result.findingClusters?.items.flatMap((cluster) => cluster.memberFindingIds)).toHaveLength(result.findings.length);
    expect(result.findingClusters?.clusters).toBeGreaterThan(0);
    expect(result.report?.enabled).toBe(true);
    expect(result.report?.videos).toBe(1);
    expect(result.report?.findings).toBeGreaterThan(0);

    const htmlPath = result.report?.htmlPath;
    const dataPath = result.report?.dataPath;
    if (!htmlPath || !dataPath) throw new Error('report paths unavailable');
    expect((await stat(htmlPath)).size).toBeGreaterThan(1000);
    const html = await readFile(htmlPath, 'utf8');
    const data = await readFile(dataPath, 'utf8');
    expect(html).toContain('Visible text is clipped');
    expect(html).toContain('../screenshots/');
    expect(html).toContain('../videos/');
    expect(data).toContain('"classification": "product-defect"');
    expect(data).toContain('"sourceMapping"');
  }, 30_000);
});
