import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MiniMaxUxReasoner } from '../src/providers/minimax-ux-reasoner.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('MiniMax UX reasoner', () => {
  it('sends aggregate-only UX context and returns bounded opportunities', async () => {
    let requestBody = '';
    const server = createServer((request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk) => { requestBody += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ opportunities: [{
            category: 'discoverability', impact: 'medium', confidence: 0.9,
            title: 'Clarify the main action', observation: 'Primary action density is low',
            recommendation: 'Expose one primary completion action', expectedEffect: 'Reduce task ambiguity', metric: 'primary-action clarity',
          }] }) } }],
        }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const reasoner = new MiniMaxUxReasoner('test-key', 'minimax-m3', `http://127.0.0.1:${address.port}/v1`);
    const result = await reasoner.propose({
      pages: [{
        urlPath: '/settings', routeDepth: 1, interactiveCount: 20, buttonCount: 4, linkCount: 8,
        formFieldCount: 6, unlabeledInteractiveCount: 2, headings: 3, h1Count: 1,
        primaryActionKinds: ['save'], ambiguousActionCount: 1, textChars: 1200, scrollRatio: 1.8,
        navLandmarks: 2, hasMeaningfulTitle: true,
      }],
      flow: { actions: 12, repeatedActions: 2, backtracks: 1, errors: 0 },
      deterministic: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe('discoverability');
    expect(requestBody).toContain('interactiveCount');
    expect(requestBody).not.toMatch(/password|cookie|bearer\s+[A-Za-z0-9]/i);
  });
});
