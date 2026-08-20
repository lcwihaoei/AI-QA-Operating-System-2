import { z } from 'zod';
import { isSecureServiceEndpoint } from '../security/url-policy.js';
import type { FixModel, FixModelContext, FixProposal } from '../fix/fix-types.js';

const command = z.object({
  program: z.string().min(1).max(50),
  args: z.array(z.string().max(500)).max(40),
});
const proposal = z.object({
  findingFingerprint: z.string().min(1).max(100),
  summary: z.string().min(1).max(2_000),
  replacements: z.array(z.object({
    path: z.string().min(1).max(500),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    content: z.string().max(200_000),
  })).min(1).max(8),
  targetedTests: z.array(command).min(1).max(8),
  reproduction: command,
  regression: command,
});

export class HttpFixModel implements FixModel {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly timeoutMs = 30_000,
  ) {
    if (!isSecureServiceEndpoint(endpoint)) throw new Error('fix model endpoint must use HTTPS unless localhost/loopback');
  }

  async propose(context: FixModelContext): Promise<FixProposal> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({ version: 1, task: 'produce-minimal-verified-fix', context }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`fix model HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error('fix model response exceeded 1 MB');
    return proposal.parse(JSON.parse(text));
  }
}
