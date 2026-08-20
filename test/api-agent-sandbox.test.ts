import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiAgent } from '../src/agents/api-agent.js';

const servers: Server[] = [];

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  await once(req, 'end');
  return body;
}

async function startSandboxFixture(): Promise<{
  origin: string;
  hits: () => string[];
  bodies: () => string[];
}> {
  const seen: string[] = [];
  const bodies: string[] = [];
  const openapi = {
    openapi: '3.1.0',
    paths: {
      '/api/items': {
        post: {
          operationId: 'createItem',
          requestBody: {
            required: true,
            content: { 'application/json': { example: { name: 'sandbox-item' } } },
          },
          responses: {
            '201': {
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
      '/api/items/{id}': {
        patch: {
          operationId: 'updateItem',
          parameters: [{ name: 'id', in: 'path', required: true, example: 42 }],
          requestBody: {
            required: true,
            content: { 'application/json': { example: { name: 'updated' } } },
          },
          responses: { '200': { description: 'updated' } },
        },
        delete: {
          operationId: 'deleteItem',
          parameters: [{ name: 'id', in: 'path', required: true, example: 42 }],
          responses: { '204': { description: 'deleted' } },
        },
      },
      '/api/payments': {
        post: {
          operationId: 'createPayment',
          requestBody: {
            required: true,
            content: { 'application/json': { example: { amount: 5 } } },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    },
  };

  const server = createServer(async (req, res) => {
    if (req.url === '/openapi.json') {
      seen.push('GET /openapi.json');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(openapi));
      return;
    }

    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/api/items') {
      bodies.push(await bodyOf(req));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 42, name: 'sandbox-item' }));
      return;
    }
    if (req.method === 'PATCH' && req.url === '/api/items/42') {
      bodies.push(await bodyOf(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 42, name: 'updated' }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/api/items/42') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/api/payments') {
      res.writeHead(500);
      res.end('should never execute');
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
    hits: () => [...seen],
    bodies: () => [...bodies],
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

describe('API Agent sandbox mode', () => {
  it('refuses sandbox mode before making any request when disposable confirmation is missing', async () => {
    const fixture = await startSandboxFixture();
    const result = await new ApiAgent().run({
      url: fixture.origin,
      mode: 'sandbox',
      maxOperations: 20,
      confirmDisposableTarget: false,
    });

    expect(result.summary.toolingError).toContain('disposable-target confirmation');
    expect(result.summary.operationsTested).toBe(0);
    expect(fixture.hits()).toEqual([]);
  });

  it('executes only explicitly planned non-sensitive writes after disposable confirmation', async () => {
    const fixture = await startSandboxFixture();
    const result = await new ApiAgent().run({
      url: fixture.origin,
      mode: 'sandbox',
      maxOperations: 20,
      confirmDisposableTarget: true,
    });

    expect(result.summary.operationsDiscovered).toBe(4);
    expect(result.summary.operationsTested).toBe(3);
    expect(result.summary.statefulOperationsTested).toBe(3);
    expect(result.summary.operationsSkipped).toBe(1);
    expect(fixture.hits()).toContain('POST /api/items');
    expect(fixture.hits()).toContain('PATCH /api/items/42');
    expect(fixture.hits()).toContain('DELETE /api/items/42');
    expect(fixture.hits().some((hit) => hit.includes('/api/payments'))).toBe(false);
    expect(fixture.bodies()).toContain(JSON.stringify({ name: 'sandbox-item' }));
    expect(fixture.bodies()).toContain(JSON.stringify({ name: 'updated' }));
    expect(result.events.some((event) => event.details?.skippedReason && event.message.includes('/api/payments'))).toBe(true);
  });
});
