import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiAgent } from '../src/agents/api-agent.js';

const servers: Server[] = [];

async function startYamlFixture(): Promise<string> {
  const yaml = [
    'openapi: 3.1.0',
    'paths:',
    '  /api/health:',
    '    get:',
    '      operationId: getHealth',
    '      responses:',
    "        '200':",
    '          content:',
    '            application/json:',
    '              schema:',
    '                type: object',
    '                required: [status]',
    '                properties:',
    '                  status:',
    '                    enum: [ok]',
  ].join('\n');

  const server = createServer((req, res) => {
    if (req.url === '/openapi.yaml') {
      res.writeHead(200, { 'content-type': 'application/yaml' });
      res.end(yaml);
      return;
    }
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
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
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

describe('API Agent YAML OpenAPI discovery', () => {
  it('discovers a YAML contract and executes its guarded read operation', async () => {
    const origin = await startYamlFixture();
    const result = await new ApiAgent().run({ url: origin, mode: 'safe', maxOperations: 10 });

    expect(result.summary.schemaUrl).toBe(`${origin}/openapi.yaml`);
    expect(result.summary.schemaFormat).toBe('yaml');
    expect(result.summary.operationsDiscovered).toBe(1);
    expect(result.summary.operationsTested).toBe(1);
    expect(result.events.some((event) => event.message.includes('OpenAPI YAML schema discovered'))).toBe(true);
    expect(result.events.filter((event) => event.kind === 'assertion')).toHaveLength(0);
  });
});
