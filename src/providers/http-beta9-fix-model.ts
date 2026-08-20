import { z } from 'zod';
import { isSecureServiceEndpoint } from '../security/url-policy.js';
import type { Beta9FixPlanDraft, Beta9FixModelContext, Beta9FixPlanningModel } from '../fix/beta9-fix-plan.js';

const command = z.object({ program: z.string().min(1).max(50), args: z.array(z.string().max(500)).max(40) });
const change = z.object({
  operation: z.enum(['create', 'replace']),
  path: z.string().min(1).max(500),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  content: z.string().max(250_000),
});
const planSchema = z.object({
  schemaVersion: z.literal(1),
  workItemId: z.string().min(1).max(120),
  findingFingerprint: z.string().min(1).max(200),
  summary: z.string().min(1).max(3_000),
  rootCause: z.string().min(1).max(5_000),
  recommendedChange: z.array(z.string().min(1).max(1_000)).min(1).max(20),
  regressionRisk: z.array(z.string().min(1).max(1_000)).max(20),
  confidence: z.number().min(0).max(1),
  changes: z.array(change).min(1).max(8),
  targetedTests: z.array(command).min(1).max(8),
  regression: command,
  beta7Qa: command,
});

function redact(value: string): string {
  return value
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}

export class HttpBeta9FixModel implements Beta9FixPlanningModel {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly timeoutMs = 60_000,
  ) {
    if (!isSecureServiceEndpoint(endpoint)) throw new Error('Beta.9 fix model endpoint must use HTTPS unless localhost/loopback');
  }

  async propose(context: Beta9FixModelContext): Promise<Beta9FixPlanDraft> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const redactedPaths = new Set<string>();
    const safeContext = {
      ...context,
      files: context.files.map((file) => {
        const content = redact(file.content);
        if (content !== file.content) redactedPaths.add(file.path);
        return { ...file, content };
      }),
    };
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({
        version: 1,
        task: 'diagnose-selected-beta7-finding-and-produce-bounded-fix-plan',
        constraints: {
          planBeforeMutation: true,
          evidenceBasedRootCause: true,
          sourceNotConfirmedWhenUncertain: true,
          preserveExistingDesignSystem: true,
          smallestSafeChange: true,
          noBroadSuppression: true,
          noShell: true,
          noGit: true,
          noSecretFiles: true,
          noWorkflowMutation: true,
          noFileDeletion: true,
          targetedRegressionAndBeta7Required: true,
          doNotDisableSecurityControlsToPassTests: true,
          retryMustUseFreshPostQaEvidence: true,
          doNotRepeatPriorFailedApproachWithoutNewEvidence: true,
          redactedSourceIsReadOnly: true,
        },
        context: safeContext,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Beta.9 fix model HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Beta.9 fix model response exceeded 2 MB');
    const parsed = planSchema.parse(JSON.parse(text));
    const touchingRedacted = parsed.changes.filter((entry) => redactedPaths.has(entry.path)).map((entry) => entry.path);
    if (touchingRedacted.length > 0) throw new Error(`Beta.9 fix model attempted to rewrite redacted source context: ${touchingRedacted.join(', ')}`);
    if (parsed.changes.some((entry) => entry.content.includes('[REDACTED]'))) throw new Error('Beta.9 fix model returned a redaction marker inside generated source content');
    return parsed;
  }
}
