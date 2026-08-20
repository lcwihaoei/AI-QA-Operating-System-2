import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { isSecureVisualEndpoint } from '../security/url-policy.js';
import type { VisualEvidenceAssessment, VisualEvidenceInput, VisualEvidenceProvider } from '../visual/visual-evidence-provider.js';

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const responseSchema = z.object({
  assessments: z.array(z.object({
    signalIndex: z.number().int().min(0),
    verdict: z.enum(['confirm', 'reject', 'uncertain']),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(1000).optional(),
  })).max(200),
});

export class HttpVisualEvidenceProvider implements VisualEvidenceProvider {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly timeoutMs = 15_000,
  ) {
    if (!isSecureVisualEndpoint(endpoint)) {
      throw new Error('visual evidence endpoint must use HTTPS unless it is localhost/loopback');
    }
  }

  async assess(input: VisualEvidenceInput): Promise<VisualEvidenceAssessment[]> {
    const screenshot = await readFile(input.screenshotPath);
    if (screenshot.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new Error(`visual screenshot exceeds ${MAX_SCREENSHOT_BYTES} byte provider limit`);
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        context: {
          url: input.url,
          viewport: input.viewport,
          signals: input.signals,
          image: {
            mimeType: 'image/png',
            base64: screenshot.toString('base64'),
          },
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) throw new Error(`visual evidence provider HTTP ${response.status}`);
    return responseSchema.parse(await response.json()).assessments;
  }
}
