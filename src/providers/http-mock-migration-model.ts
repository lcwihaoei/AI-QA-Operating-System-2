import { z } from 'zod';
import { isSecureServiceEndpoint } from '../security/url-policy.js';
import type { MockMigrationModel, MockMigrationModelContext, MockMigrationProposalDraft } from '../backend/mock-migration-executor.js';

const command = z.object({ program: z.string().min(1).max(50), args: z.array(z.string().max(500)).max(40) });
const change = z.object({
  operation: z.enum(['create', 'replace', 'delete']),
  path: z.string().min(1).max(500),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  content: z.string().max(300_000).optional(),
});
const proposal = z.object({
  schemaVersion: z.literal(1),
  recordId: z.string().min(1).max(120),
  decisionHash: z.string().regex(/^[a-f0-9]{64}$/i),
  summary: z.string().min(1).max(3_000),
  changes: z.array(change).min(1).max(3),
  targetedTests: z.array(command).min(1).max(8),
  regression: command,
  beta7Qa: command,
});

function redact(value: string): string {
  return value
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}

export class HttpMockMigrationModel implements MockMigrationModel {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly timeoutMs = 60_000,
  ) {
    if (!isSecureServiceEndpoint(endpoint)) throw new Error('mock migration model endpoint must use HTTPS unless localhost/loopback');
  }

  async propose(context: MockMigrationModelContext): Promise<MockMigrationProposalDraft> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const safeContext = {
      ...context,
      source: { ...context.source, content: redact(context.source.content) },
      ...(context.existingSeed ? { existingSeed: { ...context.existingSeed, content: redact(context.existingSeed.content) } } : {}),
    };
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({
        version: 1,
        task: 'produce-reviewed-mock-to-live-migration-proposal',
        constraints: {
          exactApprovedSourceOnly: true,
          exactApprovedSeedDestinationOnly: true,
          noSourceReplacement: true,
          deletionRequiresApprovedDecision: true,
          liveBackendVerificationAlreadyRequired: true,
          targetedRegressionAndBeta7Required: true,
          noShell: true,
          noGit: true,
          noSecretsInSeedData: true,
        },
        context: safeContext,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`mock migration model HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1_500_000) throw new Error('mock migration model response exceeded 1.5 MB');
    return proposal.parse(JSON.parse(text));
  }
}
