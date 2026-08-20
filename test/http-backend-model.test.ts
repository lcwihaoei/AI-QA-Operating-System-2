import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackendModelContext } from '../src/backend/executor-types.js';
import { HttpBackendImplementationModel } from '../src/providers/http-backend-model.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const context: BackendModelContext = {
  workItem: {
    id: 'B8-FND-001',
    kind: 'infrastructure',
    title: 'Backend foundation',
    goal: 'Create a secure backend foundation',
    why: 'Confirmed blueprint',
    dependencies: [],
    affectedModules: ['platform'],
    affectedFiles: ['src/config.ts'],
    designRequirements: [],
    implementationPlan: ['bootstrap'],
    securityImpact: ['protect secrets'],
    risks: ['credential exposure'],
    acceptanceCriteria: ['tests pass'],
    requiredTests: ['targeted'],
    qaStrategy: ['Beta.7'],
    approval: { required: true, approved: true, scopeHash: 'a'.repeat(64) },
    execution: {
      mutationAllowed: true,
      allowedPaths: ['backend/**'],
      forbiddenPaths: ['.git/**'],
      maxAttempts: 3,
      requireCleanWorkspace: true,
      requireIsolatedBranch: true,
      requireTargetedTests: true,
      requireRegressionTests: true,
      requireBeta7Qa: true,
    },
  },
  files: [{
    path: 'src/config.ts',
    sha256: 'b'.repeat(64),
    content: `export const api_key = "super-secret-value";\nexport const header = "Bearer abc.def-123";\n`,
  }],
};

async function serverWith(handler: (body: any, response: ServerResponse, request: IncomingMessage) => void | Promise<void>): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await handler(body, response, request);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

function responseFor(change: { operation: 'create' | 'replace'; path: string; content: string; expectedSha256?: string }) {
  return {
    schemaVersion: 1,
    workItemId: context.workItem.id,
    scopeHash: context.workItem.approval.scopeHash,
    summary: 'Bounded secure proposal.',
    changes: [change],
    targetedTests: [{ program: 'npm', args: ['test'] }],
    regression: { program: 'npm', args: ['run', 'build'] },
    beta7Qa: { program: 'npm', args: ['run', 'qa'] },
  };
}

describe('HttpBackendImplementationModel security boundary', () => {
  it('redacts probable embedded secrets before sending source context to the remote model', async () => {
    const endpoint = await serverWith((body, response) => {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('super-secret-value');
      expect(serialized).not.toContain('abc.def-123');
      expect(serialized).toContain('[REDACTED]');
      expect(body.constraints).toMatchObject({ redactedSourceIsReadOnly: true, doNotDisableSecurityControlsToPassTests: true });
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(responseFor({ operation: 'create', path: 'backend/app.ts', content: 'export const ready = true;\n' })));
    });
    const proposal = await new HttpBackendImplementationModel(endpoint).propose(context);
    expect(proposal.changes).toEqual([{ operation: 'create', path: 'backend/app.ts', content: 'export const ready = true;\n' }]);
  });

  it('refuses a model rewrite of any source file whose context required redaction', async () => {
    const endpoint = await serverWith((_body, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(responseFor({
        operation: 'replace',
        path: 'src/config.ts',
        expectedSha256: 'b'.repeat(64),
        content: 'export const api_key = process.env.API_KEY;\n',
      })));
    });
    await expect(new HttpBackendImplementationModel(endpoint).propose(context)).rejects.toThrow(/rewrite redacted source context/i);
  });

  it('refuses generated source that contains a redaction placeholder', async () => {
    const endpoint = await serverWith((_body, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(responseFor({ operation: 'create', path: 'backend/app.ts', content: 'export const value = "[REDACTED]";\n' })));
    });
    await expect(new HttpBackendImplementationModel(endpoint).propose(context)).rejects.toThrow(/redaction marker/i);
  });
});
