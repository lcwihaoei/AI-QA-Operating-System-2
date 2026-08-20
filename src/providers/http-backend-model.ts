import { z } from 'zod';
import { isSecureServiceEndpoint } from '../security/url-policy.js';
import type { BackendImplementationModel, BackendModelContext, BackendTaskProposalDraft } from '../backend/executor-types.js';

const command = z.object({
  program: z.string().min(1).max(50),
  args: z.array(z.string().max(500)).max(40),
});
const change = z.object({
  operation: z.enum(['create', 'replace']),
  path: z.string().min(1).max(500),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  content: z.string().max(250_000),
});
const proposal = z.object({
  schemaVersion: z.literal(1),
  workItemId: z.string().min(1).max(120),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/i),
  summary: z.string().min(1).max(3_000),
  changes: z.array(change).min(1).max(12),
  targetedTests: z.array(command).min(1).max(8),
  regression: command,
  beta7Qa: command.optional(),
});

export class HttpBackendImplementationModel implements BackendImplementationModel {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly timeoutMs = 60_000,
  ) {
    if (!isSecureServiceEndpoint(endpoint)) throw new Error('backend implementation model endpoint must use HTTPS unless localhost/loopback');
  }

  async propose(context: BackendModelContext): Promise<BackendTaskProposalDraft> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({
        version: 1,
        task: 'produce-bounded-security-first-backend-task-proposal',
        constraints: {
          noShell: true,
          noGit: true,
          noSecretFiles: true,
          noWorkflowMutation: true,
          exactApprovedScopeOnly: true,
          doNotDeleteMocks: true,
        },
        context,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`backend implementation model HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('backend implementation model response exceeded 2 MB');
    return proposal.parse(JSON.parse(text));
  }
}
