import { createHash, randomBytes } from 'node:crypto';
import { chromium, request, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import type { BrowserStorageState } from '../core/browser-state.js';
import type { QaEvent, SemanticStateSummary } from '../core/types.js';
import { parseOpenApiSource } from '../api/openapi-document-parser.js';
import { parseOpenApiOperations, planSafeApiRequest, type ApiOperationModel } from '../api/openapi-model.js';

const OPENAPI_CANDIDATES = [
  '/openapi.json',
  '/openapi.yaml',
  '/openapi.yml',
  '/swagger.json',
  '/swagger.yaml',
  '/swagger.yml',
  '/api/openapi.json',
  '/api/openapi.yaml',
  '/api/openapi.yml',
  '/v3/api-docs',
  '/api-docs/openapi.json',
  '/api-docs/openapi.yaml',
  '/api-docs/openapi.yml',
] as const;

const MAX_API_FACTS = 80;
const MAX_UI_PAGES = 12;
const MAX_UI_FIELDS_PER_PAGE = 120;
const SENSITIVE_KEY_PATTERN = /(?:^|[^a-z0-9])(password|passwd|token|secret|credential|authorization|cookie|session|otp|csrf|api[-_]?key|private[-_]?key)(?:$|[^a-z0-9])/i;
const SENSITIVE_CONTROL_PATTERN = /password|passcode|token|secret|credential|authorization|cookie|session|otp|one[-_ ]?time|csrf|api[-_ ]?key|private[-_ ]?key|card|cvv|cvc|iban|routing|bank|account[-_ ]?number/i;
const LOW_SIGNAL_KEY_PATTERN = /^(id|uuid|createdat|updatedat|deletedat|timestamp|version)$/i;
const GENERIC_PATH_SEGMENTS = new Set(['api', 'v1', 'v2', 'v3', 'rest', 'graphql', 'me', 'current']);

export interface SemanticStateAgentOptions {
  url: string;
  visitedUrls: string[];
  maxOperations: number;
  storageState?: BrowserStorageState;
}

export interface SemanticStateAgentResult {
  events: QaEvent[];
  summary: SemanticStateSummary;
}

type ScalarType = 'string' | 'number' | 'boolean' | 'null';

interface ApiFact {
  key: string;
  canonicalKey: string;
  valueHash: string;
  type: ScalarType;
  apiPath: string;
  relativeUrl: string;
  operationId?: string;
}

interface UiFieldFact {
  pageUrl: string;
  identities: string[];
  valueHash: string;
  type: string;
  formActionPath?: string;
}

function canonicalIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeScalar(value: unknown): { normalized: string; type: ScalarType } | undefined {
  if (value === null) return { normalized: 'null', type: 'null' };
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (normalized.length > 240) return undefined;
    return { normalized, type: 'string' };
  }
  if (typeof value === 'number' && Number.isFinite(value)) return { normalized: String(value), type: 'number' };
  if (typeof value === 'boolean') return { normalized: value ? 'true' : 'false', type: 'boolean' };
  return undefined;
}

function hashValue(salt: Buffer, normalized: string): string {
  return createHash('sha256').update(salt).update('\0').update(normalized).digest('hex').slice(0, 24);
}

function flattenApiFacts(
  value: unknown,
  salt: Buffer,
  operation: ApiOperationModel,
  relativeUrl: string,
): ApiFact[] {
  const facts: ApiFact[] = [];

  const visit = (node: unknown, path: string[], depth: number): void => {
    if (facts.length >= MAX_API_FACTS || depth > 3) return;
    const scalar = normalizeScalar(node);
    if (scalar) {
      const key = path[path.length - 1] ?? '';
      const canonicalKey = canonicalIdentifier(key);
      if (!canonicalKey || LOW_SIGNAL_KEY_PATTERN.test(canonicalKey) || SENSITIVE_KEY_PATTERN.test(key)) return;
      facts.push({
        key,
        canonicalKey,
        valueHash: hashValue(salt, scalar.normalized),
        type: scalar.type,
        apiPath: operation.path,
        relativeUrl,
        operationId: operation.operationId,
      });
      return;
    }

    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      visit(child, [...path, key], depth + 1);
      if (facts.length >= MAX_API_FACTS) break;
    }
  };

  visit(value, [], 0);
  return facts;
}

function pathTokens(value: string): Set<string> {
  try {
    const pathname = value.startsWith('http') ? new URL(value).pathname : value;
    return new Set(
      pathname
        .split('/')
        .map((segment) => segment.trim().toLowerCase())
        .filter((segment) => segment && !segment.startsWith('{') && !GENERIC_PATH_SEGMENTS.has(segment)),
    );
  } catch {
    return new Set();
  }
}

function pathsShareScope(apiPath: string, pageUrl: string, formActionPath?: string): boolean {
  const apiTokens = pathTokens(apiPath);
  if (apiTokens.size === 0) return false;
  const pageTokens = pathTokens(pageUrl);
  for (const token of apiTokens) if (pageTokens.has(token)) return true;
  if (formActionPath) {
    const actionTokens = pathTokens(formActionPath);
    for (const token of apiTokens) if (actionTokens.has(token)) return true;
  }
  return false;
}

export class SemanticStateAgent {
  async run(options: SemanticStateAgentOptions): Promise<SemanticStateAgentResult> {
    const events: QaEvent[] = [];
    const summary: SemanticStateSummary = {
      enabled: true,
      apiFactsObserved: 0,
      uiFieldsObserved: 0,
      comparisons: 0,
      matches: 0,
      mismatches: 0,
      ambiguousSkipped: 0,
    };

    const origin = new URL(options.url).origin;
    const salt = randomBytes(16);
    let api: APIRequestContext | undefined;
    let browser: Browser | undefined;

    try {
      api = await request.newContext({
        baseURL: origin,
        storageState: options.storageState,
        extraHTTPHeaders: { accept: 'application/json, application/*+json;q=0.9, application/yaml;q=0.5, text/yaml;q=0.5, */*;q=0.1' },
      });
      const document = await this.discover(api, origin, events);
      if (!document) return { events, summary };

      const apiFacts = await this.collectApiFacts(api, origin, document, salt, Math.min(options.maxOperations, 20), events);
      summary.apiFactsObserved = apiFacts.length;
      if (apiFacts.length === 0) return { events, summary };

      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ storageState: options.storageState });
      const page = await context.newPage();
      const uiFacts = await this.collectUiFacts(page, origin, options.visitedUrls, salt, events);
      summary.uiFieldsObserved = uiFacts.length;
      await context.close();

      const factsByCanonical = new Map<string, ApiFact[]>();
      for (const fact of apiFacts) {
        const list = factsByCanonical.get(fact.canonicalKey) ?? [];
        list.push(fact);
        factsByCanonical.set(fact.canonicalKey, list);
      }

      for (const [canonicalKey, facts] of factsByCanonical) {
        const distinctHashes = new Set(facts.map((fact) => fact.valueHash));
        if (distinctHashes.size !== 1) {
          summary.ambiguousSkipped += 1;
          continue;
        }

        const expected = facts[0]!;
        const candidateFields = uiFacts.filter((field) =>
          field.identities.includes(canonicalKey) && pathsShareScope(expected.apiPath, field.pageUrl, field.formActionPath),
        );
        if (candidateFields.length === 0) continue;

        summary.comparisons += 1;
        if (candidateFields.some((field) => field.valueHash === expected.valueHash)) {
          summary.matches += 1;
          events.push(this.event('snapshot', candidateFields[0]!.pageUrl, `Semantic state matched for field ${expected.key}`, {
            semanticState: true,
            api: true,
            semanticVerdict: 'match',
            fieldKey: expected.key,
            apiPath: expected.apiPath,
            operationId: expected.operationId,
            valuesHashed: true,
          }));
          continue;
        }

        summary.mismatches += 1;
        const target = candidateFields[0]!;
        events.push(this.event('assertion', target.pageUrl, `Semantic state mismatch: UI field "${expected.key}" differs from successful API state at ${expected.apiPath}`, {
          semanticState: true,
          api: true,
          semanticVerdict: 'mismatch',
          severityHint: 'medium',
          confidence: 'medium',
          fieldKey: expected.key,
          apiPath: expected.apiPath,
          relativeUrl: expected.relativeUrl,
          operationId: expected.operationId,
          uiPageUrl: target.pageUrl,
          uiFieldType: target.type,
          valuesHashed: true,
        }));
      }

      return { events, summary };
    } catch (error: unknown) {
      summary.toolingError = String(error);
      events.push(this.event('snapshot', origin, 'Semantic state QA stopped without a product verdict', {
        semanticState: true,
        toolingError: String(error),
      }));
      return { events, summary };
    } finally {
      await api?.dispose().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  private async discover(api: APIRequestContext, origin: string, events: QaEvent[]): Promise<unknown | undefined> {
    for (const candidate of OPENAPI_CANDIDATES) {
      const response = await api.get(candidate, { timeout: 8_000, failOnStatusCode: false, maxRedirects: 0 }).catch(() => undefined);
      if (!response) continue;
      try {
        if (response.status() < 200 || response.status() >= 300) continue;
        const source = await response.text().catch(() => undefined);
        if (source === undefined) continue;
        const url = new URL(candidate, origin).toString();
        try {
          const parsed = parseOpenApiSource(source, response.headers()['content-type'] ?? '', url);
          if (parseOpenApiOperations(parsed.document).some((operation) => operation.method === 'GET')) {
            events.push(this.event('snapshot', url, 'Semantic state agent reused same-origin OpenAPI contract', {
              semanticState: true,
              schemaFormat: parsed.format,
            }));
            return parsed.document;
          }
        } catch (error: unknown) {
          events.push(this.event('snapshot', url, 'Semantic state OpenAPI candidate could not be parsed', {
            semanticState: true,
            toolingError: String(error),
          }));
        }
      } finally {
        await response.dispose().catch(() => undefined);
      }
    }
    return undefined;
  }

  private async collectApiFacts(
    api: APIRequestContext,
    origin: string,
    document: unknown,
    salt: Buffer,
    budget: number,
    events: QaEvent[],
  ): Promise<ApiFact[]> {
    const facts: ApiFact[] = [];
    const operations = parseOpenApiOperations(document).filter((operation) => operation.method === 'GET');
    let executed = 0;

    for (const operation of operations) {
      if (executed >= budget || facts.length >= MAX_API_FACTS) break;
      const planned = planSafeApiRequest(operation);
      if (!planned.relativeUrl) continue;
      executed += 1;
      const response = await api.get(planned.relativeUrl, {
        timeout: 8_000,
        failOnStatusCode: false,
        maxRedirects: 0,
      }).catch(() => undefined);
      if (!response) continue;
      try {
        const status = response.status();
        const contentType = response.headers()['content-type'] ?? '';
        if (status < 200 || status >= 300 || !/json/i.test(contentType)) continue;
        const payload = await response.json().catch(() => undefined);
        if (payload === undefined) continue;
        const observed = flattenApiFacts(payload, salt, operation, planned.relativeUrl);
        facts.push(...observed.slice(0, Math.max(0, MAX_API_FACTS - facts.length)));
        events.push(this.event('snapshot', new URL(planned.relativeUrl, origin).toString(), `Semantic API state observed from ${operation.method} ${planned.relativeUrl}`, {
          semanticState: true,
          api: true,
          method: operation.method,
          apiPath: operation.path,
          operationId: operation.operationId,
          scalarFacts: observed.length,
          valuesHashed: true,
        }));
      } finally {
        await response.dispose().catch(() => undefined);
      }
    }
    return facts;
  }

  private async collectUiFacts(
    page: Page,
    origin: string,
    visitedUrls: string[],
    salt: Buffer,
    events: QaEvent[],
  ): Promise<UiFieldFact[]> {
    const facts: UiFieldFact[] = [];
    const unique = [...new Set(visitedUrls)].filter((value) => {
      try {
        return new URL(value).origin === origin;
      } catch {
        return false;
      }
    }).slice(0, MAX_UI_PAGES);

    for (const url of unique) {
      const navigated = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12_000 }).then(() => true).catch(() => false);
      if (!navigated) continue;
      await page.waitForTimeout(220);
      const raw = await page.locator('input:not([type="hidden"]):not([type="password"]), textarea, select').evaluateAll(
        (elements, maxFields) => elements.slice(0, maxFields).map((element) => {
          const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          const rect = (element as HTMLElement).getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;
          const labels = 'labels' in control
            ? Array.from(control.labels ?? []).map((label) => label.innerText.trim()).filter(Boolean)
            : [];
          const identities = [
            control.getAttribute('name') ?? '',
            control.id,
            control.getAttribute('aria-label') ?? '',
            control.getAttribute('placeholder') ?? '',
            ...labels,
          ].filter(Boolean);
          return {
            visible,
            identities,
            value: control.value,
            type: control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
            autocomplete: control.getAttribute('autocomplete') ?? '',
            formAction: control.form?.action || undefined,
          };
        }),
        MAX_UI_FIELDS_PER_PAGE,
      ).catch(() => [] as Array<{
        visible: boolean;
        identities: string[];
        value: string;
        type: string;
        autocomplete: string;
        formAction?: string;
      }>);

      let observed = 0;
      for (const item of raw) {
        if (!item.visible) continue;
        if (item.type === 'password' || SENSITIVE_CONTROL_PATTERN.test(item.autocomplete) || item.identities.some((identity) => SENSITIVE_CONTROL_PATTERN.test(identity))) continue;
        const scalar = normalizeScalar(item.value);
        if (!scalar) continue;
        const identities = [...new Set(item.identities.map(canonicalIdentifier).filter(Boolean))];
        if (identities.length === 0) continue;
        let formActionPath: string | undefined;
        if (item.formAction) {
          try {
            const parsed = new URL(item.formAction, url);
            if (parsed.origin === origin) formActionPath = parsed.pathname;
          } catch {
            // Ignore malformed form actions.
          }
        }
        facts.push({
          pageUrl: url,
          identities,
          valueHash: hashValue(salt, scalar.normalized),
          type: item.type,
          formActionPath,
        });
        observed += 1;
      }

      events.push(this.event('snapshot', url, 'Semantic UI field state observed', {
        semanticState: true,
        uiFields: observed,
        valuesHashed: true,
      }));
    }

    return facts;
  }

  private event(kind: QaEvent['kind'], url: string, message: string, details?: Record<string, unknown>): QaEvent {
    return { timestamp: new Date().toISOString(), kind, url, message, details };
  }
}
