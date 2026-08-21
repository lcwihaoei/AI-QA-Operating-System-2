import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { isSecureServiceEndpoint } from '../security/url-policy.js';

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
});

class MiniMaxHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`MiniMax HTTP ${status}`);
    this.name = 'MiniMaxHttpError';
  }
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function stripReasoningAndFences(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
}

function findBalancedJson(content: string): string | undefined {
  const source = stripReasoningAndFences(content);
  for (let start = 0; start < source.length; start += 1) {
    const opening = source[start];
    if (opening !== '{' && opening !== '[') continue;
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index]!;
      if (quoted) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === opening) depth += 1;
      if (char === closing) depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

export function extractMiniMaxJson(content: string): unknown {
  const balanced = findBalancedJson(content);
  if (!balanced) throw new Error('MiniMax response did not contain balanced JSON');
  return JSON.parse(balanced) as unknown;
}

export function normalizeMiniMaxModel(model?: string): string {
  const value = (model || 'minimax-m3').trim();
  if (/^minimax[-_ ]?m3$/i.test(value)) return 'MiniMax-M3';
  return value;
}

export interface MiniMaxCallStats {
  attempts: number;
  latencyMs: number;
  model: string;
  schemaRepairAttempts: number;
  schemaRepairUsed: boolean;
}

function schemaIssueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ')
    .slice(0, 2_000);
}

function repairPayload(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized) return 'null';
  return serialized.slice(0, 32_000);
}

export class MiniMaxChatClient {
  private readonly baseUrl: string;
  private readonly resolvedModel: string;
  private lastCallStats?: MiniMaxCallStats;

  constructor(
    private readonly apiKey: string,
    model = 'minimax-m3',
    baseUrl = 'https://api.minimaxi.com/v1',
    private readonly timeoutMs = integerEnv('MINIMAX_TIMEOUT_MS', 45_000, 1_000, 180_000),
    private readonly retryAttempts = integerEnv('MINIMAX_RETRY_ATTEMPTS', 3, 1, 5),
    private readonly retryBackoffMs = 750,
  ) {
    if (!apiKey.trim()) throw new Error('MiniMax API key is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) throw new Error('MiniMax timeout must be at least 1000 ms');
    if (!Number.isInteger(retryAttempts) || retryAttempts < 1 || retryAttempts > 5) throw new Error('MiniMax retry attempts must be between 1 and 5');
    const normalized = baseUrl.replace(/\/+$/, '');
    if (!isSecureServiceEndpoint(normalized)) throw new Error('MiniMax base URL must use HTTPS unless localhost/loopback');
    this.baseUrl = normalized;
    this.resolvedModel = normalizeMiniMaxModel(model);
  }

  getLastCallStats(): MiniMaxCallStats | undefined {
    return this.lastCallStats ? { ...this.lastCallStats } : undefined;
  }

  private endpoint(): string {
    return this.resolvedModel === 'MiniMax-M3'
      ? `${this.baseUrl}/text/chatcompletion_v2`
      : `${this.baseUrl}/chat/completions`;
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof MiniMaxHttpError) return error.retryable;
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) return true;
    if (error instanceof TypeError) return true;
    return error instanceof Error && /timeout|timed out|fetch failed/i.test(error.message);
  }

  private async performRequest(system: string, prompt: string): Promise<string> {
    const response = await fetch(this.endpoint(), {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.resolvedModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        top_p: 0.9,
        max_completion_tokens: 2048,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await response.text();
    if (text.length > 1_000_000) throw new Error('MiniMax response exceeded 1 MB');
    if (!response.ok) {
      throw new MiniMaxHttpError(response.status, response.status === 408 || response.status === 429 || response.status >= 500);
    }
    const parsed = responseSchema.parse(JSON.parse(text));
    return parsed.choices[0]!.message.content;
  }

  private async repairSchema<T>(value: unknown, error: z.ZodError, schema: z.ZodType<T>): Promise<T> {
    const system = 'You repair JSON structure only. Return JSON only. Preserve existing values and candidate IDs. Do not invent new recommendations, actions, permissions, or product facts. If a required array is missing and there are no existing items to preserve, use an empty array.';
    const prompt = `The previous JSON failed validation. Repair only the structural/schema errors. Validation issues: ${schemaIssueSummary(error)}. Previous JSON: ${repairPayload(value)}`;
    const content = await this.performRequest(system, prompt);
    return schema.parse(extractMiniMaxJson(content));
  }

  async completeJson<T>(system: string, prompt: string, schema: z.ZodType<T>): Promise<T> {
    const startedAt = Date.now();
    let lastError: unknown;
    let attemptsMade = 0;
    let schemaRepairAttempts = 0;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      attemptsMade = attempt;
      try {
        const content = await this.performRequest(system, prompt);
        const extracted = extractMiniMaxJson(content);
        try {
          const result = schema.parse(extracted);
          this.lastCallStats = {
            attempts: attempt,
            latencyMs: Date.now() - startedAt,
            model: this.resolvedModel,
            schemaRepairAttempts,
            schemaRepairUsed: false,
          };
          return result;
        } catch (error: unknown) {
          if (!(error instanceof z.ZodError)) throw error;
          schemaRepairAttempts = 1;
          attemptsMade = attempt + 1;
          try {
            const repaired = await this.repairSchema(extracted, error, schema);
            this.lastCallStats = {
              attempts: attemptsMade,
              latencyMs: Date.now() - startedAt,
              model: this.resolvedModel,
              schemaRepairAttempts,
              schemaRepairUsed: true,
            };
            return repaired;
          } catch (repairError: unknown) {
            const initial = schemaIssueSummary(error);
            lastError = new Error(`MiniMax schema repair failed; initial validation: ${initial}; repair error: ${String(repairError)}`);
            break;
          }
        }
      } catch (error: unknown) {
        lastError = error;
        if (attempt >= this.retryAttempts || !this.shouldRetry(error)) break;
        const backoff = Math.min(this.retryBackoffMs * (2 ** (attempt - 1)), 8_000);
        await delay(backoff);
      }
    }

    this.lastCallStats = {
      attempts: attemptsMade,
      latencyMs: Date.now() - startedAt,
      model: this.resolvedModel,
      schemaRepairAttempts,
      schemaRepairUsed: false,
    };
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
