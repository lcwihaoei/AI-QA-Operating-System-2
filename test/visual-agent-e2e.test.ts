import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VisualAgent, VISUAL_VIEWPORTS } from '../src/agents/visual-agent.js';
import { EvidenceStore } from '../src/evidence/evidence-store.js';
import type { DomGeometryAnalyzer } from '../src/visual/dom-geometry-analyzer.js';

const enabled = process.env.AIQA_BROWSER_E2E === '1';
const servers: Array<ReturnType<typeof createServer>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!enabled)('VisualAgent real Chromium provenance', () => {
  it('does not count an HTTP-200 page as analyzed when the geometry analyzer fails', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><title>Visual fixture</title></head><body><h1>Fixture</h1></body></html>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-visual-e2e-'));
    tempDirs.push(dir);
    const evidence = new EvidenceStore(dir, 'run');
    await evidence.init();
    const failingAnalyzer = {
      analyze: async () => { throw new Error('intentional analyzer failure'); },
    } as unknown as DomGeometryAnalyzer;
    const agent = new VisualAgent(evidence, failingAnalyzer, [VISUAL_VIEWPORTS.desktop]);
    const result = await agent.run([`http://127.0.0.1:${address.port}/`]);

    expect(result.analyzedStates).toBe(0);
    expect(result.events.some((event) => event.message.startsWith('DOM geometry analysis skipped'))).toBe(true);
    expect(result.events.some((event) => event.details?.analysisSucceeded === true)).toBe(false);
  });

  it('counts a clean zero-signal page only after geometry analysis succeeds', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><title>Visual fixture</title></head><body><h1>Fixture</h1></body></html>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-visual-e2e-'));
    tempDirs.push(dir);
    const evidence = new EvidenceStore(dir, 'run');
    await evidence.init();
    const cleanAnalyzer = { analyze: async () => [] } as unknown as DomGeometryAnalyzer;
    const agent = new VisualAgent(evidence, cleanAnalyzer, [VISUAL_VIEWPORTS.desktop]);
    const result = await agent.run([`http://127.0.0.1:${address.port}/`]);

    expect(result.analyzedStates).toBe(1);
    expect(result.events.some((event) => event.details?.analysisSucceeded === true && event.details?.signalCount === 0)).toBe(true);
  });
});
