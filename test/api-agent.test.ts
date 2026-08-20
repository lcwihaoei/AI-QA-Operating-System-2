import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiAgent } from '../src/agents/api-agent.js';

const servers: Server[] = [];

async function startFixture(): Promise<{ origin: string; redirectTargetHits: () => number }> {
  let redirectedHits = 0;
  const openapi = {
    openapi: '3.1.0',
    paths: {
      '/api/ok': {
        get: {
          operationId: 'getOk',
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'name'],
                    properties: { id: { type: 'integer' }, name: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/missing': {
        get: {
          operationId: 'getMissing',
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'name'],
                    properties: { id: { type: 'integer' }, name: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/failure': {
        get: {
          operationId: 'getFailure',
          responses: { '200': { description: 'expected success' } },
        },
      },
      '/api/redirect': {
        get: {
          operationId: 'getRedirect',
          responses: { '302': { description: 'redirect' } },
        },
      },
      '/auth/logout': {
        get: {
          operationId: 'logoutUser',
          responses: { '204': { description: 'session ended' } },
        },
      },
    },
  };

  const server = createServer((req, res) => {
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(openapi));
      return;
    }
    if (req.url === '/api/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 1, name: 'ok' }));
      return;
    }
    if (req.url === '/api/missing') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 2 }));
      return;
    }
    if (req.url === '/api/failure') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'temporary' }));
      return;
    }
    if (req.url === '/api/redirect') {
      res.writeHead(302, { location: '/redirect-target' });
      res.end();
      return;
    }
    if (req.url === '/redirect-target') {
      redirectedHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ followed: true }));
      return;
    }
    if (req.url === '/auth/logout') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    redirectTargetHits: () => redirectedHits,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

describe('API Agent safe mode', () => {
  it('discovers OpenAPI, executes safe reads, reports contract failures and never follows redirects', async () => {
    const fixture = await startFixture();
    const result = await new ApiAgent().run({
      url: fixture.origin,
      mode: 'safe',
      maxOperations: 20,
    });

    expect(result.summary.schemaUrl).toBe(`${fixture.origin}/openapi.json`);
    expect(result.summary.operationsDiscovered).toBe(5);
    expect(result.summary.operationsTested).toBe(4);
    expect(result.summary.operationsSkipped).toBe(1);
    expect(fixture.redirectTargetHits()).toBe(0);

    const assertions = result.events.filter((event) => event.kind === 'assertion');
    const schemaFinding = assertions.find((event) => event.message.includes('does not satisfy the OpenAPI response schema'));
    expect(schemaFinding).toBeDefined();
    expect(Array.isArray(schemaFinding?.details?.schemaIssues)).toBe(true);
    expect(assertions.some((event) => event.message.includes('server error 503'))).toBe(true);
    expect(result.events.some((event) => event.details?.skippedReason && event.message.includes('/auth/logout'))).toBe(true);
    expect(result.events.some((event) => event.details?.redirectFollowed === false && event.message.includes('/api/redirect'))).toBe(true);
  });

  it('supports discovery-only mode without executing business endpoints', async () => {
    const fixture = await startFixture();
    const result = await new ApiAgent().run({
      url: fixture.origin,
      mode: 'discover',
      maxOperations: 20,
    });

    expect(result.summary.operationsDiscovered).toBe(5);
    expect(result.summary.operationsTested).toBe(0);
    expect(result.events.filter((event) => event.kind === 'action')).toHaveLength(0);
  });
});
