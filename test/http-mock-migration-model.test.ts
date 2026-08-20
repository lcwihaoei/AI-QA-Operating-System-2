import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { MockMigrationModelContext } from '../src/backend/mock-migration-executor.js';
import { HttpMockMigrationModel } from '../src/providers/http-mock-migration-model.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function context(): MockMigrationModelContext {
  return {
    record: {
      id: 'MOCK-ABC', source: 'src/mock.ts', kind: 'mock-file', selectedAction: 'convert-to-seed', seedDestination: 'backend/seed.ts',
      removeSourceAfterSeed: false, approval: { approved: true, decisionHash: 'a'.repeat(64), approvedBy: 'owner' }, liveVerificationEvidence: ['live:npm test'],
    },
    source: { path: 'src/mock.ts', sha256: 'b'.repeat(64), content: 'const api_key="super-secret-value"; export const rows=[1];\n' },
  };
}

async function endpoint(handler: (body: any) => unknown): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(handler(body)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test endpoint unavailable');
  return `http://127.0.0.1:${address.port}`;
}

function validProposal() {
  return {
    schemaVersion: 1,
    recordId: 'MOCK-ABC',
    decisionHash: 'a'.repeat(64),
    summary: 'Create seed data.',
    changes: [{ operation: 'create', path: 'backend/seed.ts', content: 'export const rows=[1];\n' }],
    targetedTests: [{ program: 'npm', args: ['test'] }],
    regression: { program: 'npm', args: ['run', 'build'] },
    beta7Qa: { program: 'npm', args: ['run', 'qa'] },
  };
}

describe('HttpMockMigrationModel secret boundaries', () => {
  it('redacts probable credentials before sending mock source context', async () => {
    let received = '';
    const url = await endpoint((body) => {
      received = JSON.stringify(body);
      return validProposal();
    });
    const result = await new HttpMockMigrationModel(url).propose(context());
    expect(result.changes[0]?.path).toBe('backend/seed.ts');
    expect(received).not.toContain('super-secret-value');
    expect(received).toContain('[REDACTED]');
  });

  it('treats redacted existing seed context as read-only', async () => {
    const input = context();
    input.existingSeed = { path: 'backend/seed.ts', sha256: 'c'.repeat(64), content: 'const password="keep-this-secret";\n' };
    const url = await endpoint(() => ({
      ...validProposal(),
      changes: [{ operation: 'replace', path: 'backend/seed.ts', expectedSha256: 'c'.repeat(64), content: 'export const rows=[1];\n' }],
    }));
    await expect(new HttpMockMigrationModel(url).propose(input)).rejects.toThrow(/rewrite redacted source context/i);
  });

  it('rejects generated source that contains a redaction marker', async () => {
    const url = await endpoint(() => ({
      ...validProposal(),
      changes: [{ operation: 'create', path: 'backend/seed.ts', content: 'export const token="[REDACTED]";\n' }],
    }));
    await expect(new HttpMockMigrationModel(url).propose(context())).rejects.toThrow(/redaction marker/i);
  });
});
