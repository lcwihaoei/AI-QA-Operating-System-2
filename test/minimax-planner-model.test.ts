import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MiniMaxPlannerModel } from '../src/providers/minimax-planner-model.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('MiniMax planner model', () => {
  it('sends bounded redacted planner context', async () => {
    let requestBody = '';
    const server = createServer((request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk) => { requestBody += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: '{"recommendations":[]}' } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const model = new MiniMaxPlannerModel('test-key', 'minimax-m3', `http://127.0.0.1:${address.port}/v1`);
    const recommendations = await model.recommend({
      pageUrl: 'https://example.com/settings?token=top-secret',
      depth: 1,
      riskMode: 'safe',
      pageState: {
        url: 'https://example.com/settings', title: 'Settings', headings: ['Settings'], archetypes: ['form'],
        formCount: 1, fieldCount: 2, searchFieldCount: 0, buttonCount: 1, linkCount: 2,
        hasDialog: false, hasTable: false, bodySample: 'sensitive@example.com bearer top-secret-token',
      },
      scenarios: [],
      coverage: { score: 50, pageCoverage: 50, interactionCoverage: 50, pages: [], gaps: [] },
      candidates: [],
    });

    expect(recommendations).toEqual([]);
    expect(requestBody).toContain('/settings');
    expect(requestBody).not.toContain('top-secret');
    expect(requestBody).not.toContain('sensitive@example.com');
    expect(requestBody).not.toContain('bodySample');
  });
});
