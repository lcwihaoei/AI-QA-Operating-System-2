import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Beta9FixModelContext } from '../src/fix/beta9-fix-plan.js';
import { HttpBeta9FixModel } from '../src/providers/http-beta9-fix-model.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

function context(content: string): Beta9FixModelContext {
  return {
    finding: {
      fingerprint: 'fp-1', severity: 'high', kind: 'ui', title: 'broken label', url: 'http://127.0.0.1/page',
      message: 'wrong label', reproduction: ['open page'], evidence: ['screenshot.png'],
    },
    workItem: {
      id: 'B9-FIX-ONE', title: 'Fix label', goal: 'Fix label safely', why: 'Beta.7 finding', source: [{ type: 'qa-finding', reference: 'fp-1' }],
      affectedModules: ['page'], implementationPlan: ['smallest source fix'], designRequirements: [], securityImpact: ['preserve controls'], risks: [],
      acceptanceCriteria: ['finding resolved'], requiredTests: ['targeted'], qaStrategy: ['Beta.7'],
    },
    files: [{ path: 'src/app.ts', sha256: 'a'.repeat(64), content }],
  };
}

async function endpointFor(responseFactory: (requestBody: string) => object): Promise<{ endpoint: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    bodies.push(body);
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(responseFactory(body)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return { endpoint: `http://127.0.0.1:${address.port}`, bodies };
}

function proposal(content: string) {
  return {
    schemaVersion: 1,
    workItemId: 'B9-FIX-ONE',
    findingFingerprint: 'fp-1',
    summary: 'Bounded fix',
    rootCause: 'Stale source constant',
    recommendedChange: ['Replace the stale constant'],
    regressionRisk: [],
    confidence: 0.9,
    changes: [{ operation: 'replace', path: 'src/app.ts', expectedSha256: 'a'.repeat(64), content }],
    targetedTests: [{ program: 'npm', args: ['test'] }],
    regression: { program: 'npm', args: ['run', 'build'] },
    beta7Qa: { program: 'npm', args: ['run', 'qa'] },
  };
}

describe('HttpBeta9FixModel sensitive-source boundary', () => {
  it('redacts probable credentials sent to a remote model and refuses rewrites of that redacted file', async () => {
    const server = await endpointFor(() => proposal("export const label = 'fixed';\n"));
    const model = new HttpBeta9FixModel(server.endpoint);
    await expect(model.propose(context("export const api_key = 'super-secret-value';\n"))).rejects.toThrow(/rewrite redacted source context/);
    expect(server.bodies).toHaveLength(1);
    expect(server.bodies[0]).not.toContain('super-secret-value');
    expect(server.bodies[0]).toContain('[REDACTED]');
  });

  it('accepts a bounded plan for source context that did not require redaction', async () => {
    const server = await endpointFor(() => proposal("export const label = 'fixed';\n"));
    const model = new HttpBeta9FixModel(server.endpoint);
    const result = await model.propose(context("export const label = 'broken';\n"));
    expect(result.changes).toEqual([{ operation: 'replace', path: 'src/app.ts', expectedSha256: 'a'.repeat(64), content: "export const label = 'fixed';\n" }]);
  });
});
