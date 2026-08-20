import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiAgent } from '../src/agents/api-agent.js';

const servers: Server[] = [];

async function readBody(req: IncomingMessage): Promise<string> {
  let value = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { value += chunk; });
  await once(req, 'end');
  return value;
}

async function startLifecycleFixture(failPatch = false): Promise<{ origin: string; sequence: () => string[] }> {
  let exists = false;
  let name = 'sandbox-widget';
  const sequence: string[] = [];
  const openapi = {
    openapi: '3.1.0',
    paths: {
      '/api/widgets': {
        post: {
          operationId: 'createWidget',
          requestBody: {
            required: true,
            content: { 'application/json': { example: { name: 'sandbox-widget' } } },
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
      '/api/widgets/{id}': {
        get: {
          operationId: 'getWidget',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
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
            '404': { description: 'not found' },
          },
        },
        patch: {
          operationId: 'updateWidget',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { example: { name: 'updated-widget' } } },
          },
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
        delete: {
          operationId: 'deleteWidget',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '204': { description: 'deleted' } },
        },
      },
    },
  };

  const server = createServer(async (req, res) => {
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(openapi));
      return;
    }

    sequence.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/api/widgets') {
      const body = JSON.parse(await readBody(req)) as { name: string };
      exists = true;
      name = body.name;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 73, name }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/widgets/73') {
      if (!exists) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 73, name }));
      return;
    }
    if (req.method === 'PATCH' && req.url === '/api/widgets/73') {
      if (failPatch) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forced failure' }));
        return;
      }
      const body = JSON.parse(await readBody(req)) as { name: string };
      name = body.name;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 73, name }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/api/widgets/73') {
      exists = false;
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
  return { origin: `http://127.0.0.1:${address.port}`, sequence: () => [...sequence] };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

describe('API Agent stateful sandbox lifecycle', () => {
  it('creates, verifies, updates, re-verifies, cleans up and verifies deletion using the new resource ID', async () => {
    const fixture = await startLifecycleFixture();
    const result = await new ApiAgent().run({
      url: fixture.origin,
      mode: 'sandbox',
      maxOperations: 6,
      confirmDisposableTarget: true,
    });

    expect(fixture.sequence()).toEqual([
      'POST /api/widgets',
      'GET /api/widgets/73',
      'PATCH /api/widgets/73',
      'GET /api/widgets/73',
      'DELETE /api/widgets/73',
      'GET /api/widgets/73',
    ]);
    expect(result.summary).toMatchObject({
      operationsDiscovered: 4,
      operationsTested: 6,
      statefulOperationsTested: 3,
      statefulScenariosPlanned: 1,
      statefulScenariosCompleted: 1,
      cleanupAttempts: 1,
      cleanupFailures: 0,
    });
    expect(result.events.some((event) => event.details?.statefulStep === 'bind-id' && event.details?.identityCaptured === true)).toBe(true);
    expect(result.events.some((event) => event.details?.statefulStep === 'verify-cleanup' && event.details?.status === 404)).toBe(true);
  });

  it('still executes DELETE cleanup when a middle PATCH step fails', async () => {
    const fixture = await startLifecycleFixture(true);
    const result = await new ApiAgent().run({
      url: fixture.origin,
      mode: 'sandbox',
      maxOperations: 5,
      confirmDisposableTarget: true,
    });

    expect(fixture.sequence()).toEqual([
      'POST /api/widgets',
      'GET /api/widgets/73',
      'PATCH /api/widgets/73',
      'GET /api/widgets/73',
      'DELETE /api/widgets/73',
    ]);
    expect(result.summary.cleanupAttempts).toBe(1);
    expect(result.summary.cleanupFailures).toBe(0);
    expect(result.summary.statefulScenariosCompleted).toBe(0);
    expect(result.events.some((event) => event.kind === 'assertion' && event.message.includes('server error 500'))).toBe(true);
    expect(result.events.some((event) => event.details?.statefulStep === 'cleanup' && event.details?.status === 204)).toBe(true);
  });
});
