import { createServer } from 'node:http';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { extractMiniMaxJson, MiniMaxChatClient } from '../src/providers/minimax-chat-client.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('MiniMaxChatClient', () => {
  it('uses the documented M3 CN endpoint, normalizes the model alias and parses JSON after reasoning text', async () => {
    let seenAuthorization = '';
    let seenModel = '';
    let seenPath = '';
    const server = createServer((request, response) => {
      seenAuthorization = String(request.headers.authorization ?? '');
      seenPath = request.url ?? '';
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        seenModel = String((JSON.parse(body) as { model?: string }).model ?? '');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          choices: [{ message: { content: '<think>internal reasoning</think>\n{"ok":true,"value":7}' } }],
        }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const client = new MiniMaxChatClient('secret-test-key', 'minimax-m3', `http://127.0.0.1:${address.port}/v1`);
    const result = await client.completeJson('system', 'prompt', z.object({ ok: z.boolean(), value: z.number() }));
    expect(result).toEqual({ ok: true, value: 7 });
    expect(seenAuthorization).toBe('Bearer secret-test-key');
    expect(seenModel).toBe('MiniMax-M3');
    expect(seenPath).toBe('/v1/text/chatcompletion_v2');
    expect(client.getLastCallStats()).toMatchObject({ attempts: 1, model: 'MiniMax-M3', schemaRepairAttempts: 0, schemaRepairUsed: false });
  });

  it('extracts balanced nested JSON from think blocks, fences and trailing prose', () => {
    const parsed = extractMiniMaxJson('<think>{not output}</think>\n```json\n{"outer":{"text":"brace } inside string","items":[1,2]}}\n```\nDone.');
    expect(parsed).toEqual({ outer: { text: 'brace } inside string', items: [1, 2] } });
  });

  it('retries transient MiniMax failures and records attempt stats', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        if (requests < 3) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: 'temporary' }));
          return;
        }
        response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const client = new MiniMaxChatClient('key', 'minimax-m3', `http://127.0.0.1:${address.port}/v1`, 1_000, 3, 1);
    await expect(client.completeJson('system', 'prompt', z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
    expect(requests).toBe(3);
    expect(client.getLastCallStats()).toMatchObject({ attempts: 3, model: 'MiniMax-M3', schemaRepairAttempts: 0, schemaRepairUsed: false });
  });

  it('makes at most one schema-specific repair request before returning repaired JSON', async () => {
    let requests = 0;
    let repairPrompt = '';
    const server = createServer((request, response) => {
      requests += 1;
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> };
        if (requests === 2) repairPrompt = parsed.messages?.find((message) => message.role === 'user')?.content ?? '';
        response.setHeader('content-type', 'application/json');
        const content = requests === 1 ? '{"wrong":[]}' : '{"recommendations":[]}';
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const client = new MiniMaxChatClient('key', 'minimax-m3', `http://127.0.0.1:${address.port}/v1`, 1_000, 1, 1);
    const schema = z.object({ recommendations: z.array(z.object({ candidateId: z.string() })) });
    await expect(client.completeJson('system', 'prompt', schema)).resolves.toEqual({ recommendations: [] });
    expect(requests).toBe(2);
    expect(repairPrompt).toContain('recommendations');
    expect(repairPrompt).toContain('Previous JSON');
    expect(client.getLastCallStats()).toMatchObject({
      attempts: 2,
      schemaRepairAttempts: 1,
      schemaRepairUsed: true,
      model: 'MiniMax-M3',
    });
  });

  it('does not retry non-retryable 4xx responses', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      request.on('end', () => {
        response.statusCode = 401;
        response.end('unauthorized');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');

    const client = new MiniMaxChatClient('key', 'minimax-m3', `http://127.0.0.1:${address.port}/v1`, 1_000, 3, 1);
    await expect(client.completeJson('system', 'prompt', z.object({ ok: z.boolean() }))).rejects.toThrow(/401/);
    expect(requests).toBe(1);
  });

  it('keeps the OpenAI-compatible endpoint for non-M3 configured text models', async () => {
    let seenPath = '';
    const server = createServer((request, response) => {
      seenPath = request.url ?? '';
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const client = new MiniMaxChatClient('key', 'MiniMax-M2.7', `http://127.0.0.1:${address.port}/v1`);
    await client.completeJson('system', 'prompt', z.object({ ok: z.boolean() }));
    expect(seenPath).toBe('/v1/chat/completions');
  });

  it('rejects insecure non-loopback base URLs', () => {
    expect(() => new MiniMaxChatClient('key', 'minimax-m3', 'http://example.com/v1')).toThrow(/HTTPS/);
  });
});
