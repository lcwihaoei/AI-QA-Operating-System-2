import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { BrowserStorageState } from '../core/browser-state.js';
import type { ApiMode, ApiQaSummary, QaEvent } from '../core/types.js';
import { JsonSchemaValidator } from '../api/json-schema-validator.js';
import { parseOpenApiSource, type OpenApiDocumentFormat } from '../api/openapi-document-parser.js';
import {
  contractForStatus,
  isStatusDeclared,
  parseOpenApiOperations,
  parseOpenApiWriteOperations,
  planSafeApiRequest,
  planSandboxApiRequest,
  type ApiOperationModel,
  type PlannedApiRequest,
} from '../api/openapi-model.js';
import { operationKey, planStatefulApiScenarios } from '../api/stateful-scenario-planner.js';
import { StatefulScenarioRunner } from '../api/stateful-scenario-runner.js';

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

export interface ApiAgentOptions {
  url: string;
  mode: ApiMode;
  maxOperations: number;
  storageState?: BrowserStorageState;
  confirmDisposableTarget?: boolean;
}

export interface ApiAgentResult {
  events: QaEvent[];
  summary: ApiQaSummary;
}

export class ApiAgent {
  constructor(private readonly schemaValidator: JsonSchemaValidator = new JsonSchemaValidator()) {}

  async run(options: ApiAgentOptions): Promise<ApiAgentResult> {
    if (options.mode === 'off') {
      return { events: [], summary: this.summary(false, options.mode) };
    }

    const origin = new URL(options.url).origin;
    const events: QaEvent[] = [];
    if (options.mode === 'sandbox' && options.confirmDisposableTarget !== true) {
      const toolingError = 'sandbox API mode requires explicit disposable-target confirmation';
      events.push(this.event('snapshot', origin, 'Sandbox API mode refused without disposable-target confirmation', {
        api: true,
        sandbox: true,
        toolingError,
      }));
      return {
        events,
        summary: { ...this.summary(true, options.mode), toolingError },
      };
    }

    let api: APIRequestContext | undefined;
    try {
      api = await request.newContext({
        baseURL: origin,
        storageState: options.storageState,
        extraHTTPHeaders: {
          accept: 'application/json, application/*+json;q=0.9, application/yaml;q=0.8, text/yaml;q=0.8, */*;q=0.1',
        },
      });
      const discovery = await this.discover(api, origin, events);
      if (!discovery) {
        return { events, summary: this.summary(true, options.mode) };
      }

      const readOperations = parseOpenApiOperations(discovery.document);
      const writeOperations = parseOpenApiWriteOperations(discovery.document);
      const operations = options.mode === 'sandbox'
        ? [...writeOperations, ...readOperations]
        : readOperations;
      events.push(this.event('snapshot', discovery.url, 'OpenAPI operation inventory built', {
        api: true,
        schemaUrl: discovery.url,
        schemaFormat: discovery.format,
        operationsDiscovered: operations.length,
        readOperations: readOperations.length,
        writeOperations: writeOperations.length,
        sandbox: options.mode === 'sandbox',
      }));

      if (options.mode === 'discover') {
        return {
          events,
          summary: {
            ...this.summary(true, options.mode),
            schemaUrl: discovery.url,
            schemaFormat: discovery.format,
            operationsDiscovered: readOperations.length + writeOperations.length,
          },
        };
      }

      let lifecycleOperations = 0;
      let lifecycleWriteOperations = 0;
      let lifecycleScenariosPlanned = 0;
      let lifecycleScenariosCompleted = 0;
      let cleanupAttempts = 0;
      let cleanupFailures = 0;
      const lifecycleUsedKeys = new Set<string>();

      if (options.mode === 'sandbox') {
        const scenarios = planStatefulApiScenarios(discovery.document);
        const lifecycle = await new StatefulScenarioRunner(this.schemaValidator).run(
          api,
          origin,
          scenarios,
          options.maxOperations,
        );
        events.push(...lifecycle.events);
        lifecycleOperations = lifecycle.summary.operationsTested;
        lifecycleWriteOperations = lifecycle.summary.writeOperationsTested;
        lifecycleScenariosPlanned = lifecycle.summary.scenariosPlanned;
        lifecycleScenariosCompleted = lifecycle.summary.scenariosCompleted;
        cleanupAttempts = lifecycle.summary.cleanupAttempts;
        cleanupFailures = lifecycle.summary.cleanupFailures;
        for (const key of lifecycle.summary.usedOperationKeys) lifecycleUsedKeys.add(key);
      }

      const remainingBudget = Math.max(0, options.maxOperations - lifecycleOperations);
      const remainingOperations = operations.filter((operation) => !lifecycleUsedKeys.has(operationKey(operation)));
      const limited = remainingOperations.slice(0, remainingBudget);
      const planned = limited.map((operation) => this.plan(operation, options.mode));
      let tested = 0;
      let statefulTested = 0;
      let skipped = Math.max(0, remainingOperations.length - planned.length);
      for (const item of planned) {
        if (!item.relativeUrl) {
          skipped += 1;
          events.push(this.event('snapshot', discovery.url, `API operation skipped: ${item.operation.method} ${item.operation.path}`, {
            api: true,
            sandbox: options.mode === 'sandbox',
            method: item.operation.method,
            path: item.operation.path,
            operationId: item.operation.operationId,
            skippedReason: item.skippedReason,
          }));
          continue;
        }
        tested += 1;
        if (!['GET', 'HEAD'].includes(item.operation.method)) statefulTested += 1;
        await this.execute(api, origin, item, events, options.mode === 'sandbox');
      }

      return {
        events,
        summary: {
          ...this.summary(true, options.mode),
          schemaUrl: discovery.url,
          schemaFormat: discovery.format,
          operationsDiscovered: operations.length,
          operationsTested: lifecycleOperations + tested,
          operationsSkipped: skipped,
          statefulOperationsTested: lifecycleWriteOperations + statefulTested,
          statefulScenariosPlanned: lifecycleScenariosPlanned,
          statefulScenariosCompleted: lifecycleScenariosCompleted,
          cleanupAttempts,
          cleanupFailures,
        },
      };
    } catch (error: unknown) {
      events.push(this.event('snapshot', origin, 'API QA agent stopped without a product verdict', {
        api: true,
        sandbox: options.mode === 'sandbox',
        toolingError: String(error),
      }));
      return {
        events,
        summary: { ...this.summary(true, options.mode), toolingError: String(error) },
      };
    } finally {
      await api?.dispose().catch(() => undefined);
    }
  }

  private plan(operation: ApiOperationModel, mode: ApiMode): PlannedApiRequest {
    if (['GET', 'HEAD'].includes(operation.method)) return planSafeApiRequest(operation);
    if (mode !== 'sandbox') return { operation, skippedReason: 'write operation requires sandbox API mode' };
    return planSandboxApiRequest(operation);
  }

  private async discover(
    api: APIRequestContext,
    origin: string,
    events: QaEvent[],
  ): Promise<{ url: string; document: unknown; format: OpenApiDocumentFormat } | undefined> {
    for (const candidate of OPENAPI_CANDIDATES) {
      const response = await api.get(candidate, {
        timeout: 8_000,
        failOnStatusCode: false,
        maxRedirects: 0,
      }).catch(() => undefined);
      if (!response) continue;
      try {
        if (response.status() < 200 || response.status() >= 300) continue;
        const contentType = response.headers()['content-type'] ?? '';
        const source = await response.text().catch(() => undefined);
        if (source === undefined) continue;
        const url = new URL(candidate, origin).toString();
        let parsed: ReturnType<typeof parseOpenApiSource>;
        try {
          parsed = parseOpenApiSource(source, contentType, url);
        } catch (error: unknown) {
          events.push(this.event('snapshot', url, 'OpenAPI candidate could not be parsed', {
            api: true,
            contentType,
            toolingError: String(error),
          }));
          continue;
        }
        const operationCount = parseOpenApiOperations(parsed.document).length + parseOpenApiWriteOperations(parsed.document).length;
        if (operationCount === 0) continue;
        events.push(this.event('snapshot', url, `OpenAPI ${parsed.format.toUpperCase()} schema discovered`, {
          api: true,
          schemaFormat: parsed.format,
          contentType,
        }));
        return { url, document: parsed.document, format: parsed.format };
      } finally {
        await response.dispose().catch(() => undefined);
      }
    }
    events.push(this.event('snapshot', origin, 'No JSON/YAML OpenAPI schema discovered at known same-origin locations', {
      api: true,
      candidates: OPENAPI_CANDIDATES,
    }));
    return undefined;
  }

  private async execute(
    api: APIRequestContext,
    origin: string,
    planned: PlannedApiRequest,
    events: QaEvent[],
    sandbox: boolean,
  ): Promise<void> {
    const operation = planned.operation;
    const relativeUrl = planned.relativeUrl!;
    const absoluteUrl = new URL(relativeUrl, origin).toString();
    const started = Date.now();
    const operationDetails = {
      api: true,
      sandbox,
      method: operation.method,
      path: operation.path,
      relativeUrl,
      operationId: operation.operationId,
      requestBodyUsed: planned.body !== undefined,
    };
    events.push(this.event('action', absoluteUrl, `API ${operation.method} ${relativeUrl}`, operationDetails));

    let response: APIResponse | undefined;
    try {
      response = await api.fetch(relativeUrl, {
        method: operation.method,
        data: planned.body,
        timeout: 10_000,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      const status = response.status();
      const durationMs = Date.now() - started;
      const contentType = response.headers()['content-type'] ?? '';
      const redirectLocation = response.headers().location;
      const contract = contractForStatus(operation, status);

      events.push(this.event('snapshot', absoluteUrl, `API response ${operation.method} ${relativeUrl}: ${status}`, {
        ...operationDetails,
        status,
        durationMs,
        contentType,
        declaredStatus: isStatusDeclared(operation, status),
        redirectLocation: status >= 300 && status < 400 ? redirectLocation : undefined,
        redirectFollowed: false,
      }));

      if (status >= 500) {
        events.push(this.assertion(absoluteUrl, `API returned server error ${status}: ${operation.method} ${relativeUrl}`, 'high', {
          ...operationDetails,
          status,
          durationMs,
        }));
      } else if (operation.responses.length > 0 && !isStatusDeclared(operation, status)) {
        events.push(this.assertion(absoluteUrl, `API returned undeclared status ${status}: ${operation.method} ${relativeUrl}`, 'medium', {
          ...operationDetails,
          status,
          declaredStatuses: operation.responses.map((item) => item.statusPattern),
        }));
      }

      if (contract?.expectsJson && !/json/i.test(contentType)) {
        events.push(this.assertion(absoluteUrl, `API contract expects JSON but response Content-Type is ${contentType || 'missing'}`, 'medium', {
          ...operationDetails,
          status,
        }));
      }

      if (contract?.expectsJson && /json/i.test(contentType) && operation.method !== 'HEAD') {
        let parsedBody = false;
        let payload: unknown;
        try {
          payload = await response.json();
          parsedBody = true;
        } catch {
          events.push(this.assertion(absoluteUrl, `API response declares JSON but body could not be parsed: ${operation.method} ${relativeUrl}`, 'medium', {
            ...operationDetails,
            status,
          }));
        }

        if (parsedBody && contract.schema !== undefined) {
          const validation = this.schemaValidator.validate(contract.schema, payload);
          if (validation.toolingError) {
            events.push(this.event('snapshot', absoluteUrl, 'API JSON Schema validation skipped without a product verdict', {
              ...operationDetails,
              status,
              toolingError: validation.toolingError,
            }));
          } else if (!validation.valid) {
            events.push(this.assertion(absoluteUrl, `API JSON response does not satisfy the OpenAPI response schema: ${operation.method} ${relativeUrl}`, 'medium', {
              ...operationDetails,
              status,
              schemaIssues: validation.issues,
            }));
          }
        } else if (parsedBody && contract.schema === undefined && contract.requiredProperties.length > 0) {
          const objectPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload as Record<string, unknown>
            : undefined;
          const missing = contract.requiredProperties.filter((property) => !objectPayload || !(property in objectPayload));
          if (missing.length > 0) {
            events.push(this.assertion(absoluteUrl, `API JSON response is missing required properties: ${missing.join(', ')}`, 'medium', {
              ...operationDetails,
              status,
              missingProperties: missing,
            }));
          }
        }
      }
    } catch (error: unknown) {
      events.push(this.assertion(absoluteUrl, `API request failed to complete: ${operation.method} ${relativeUrl}`, 'medium', {
        ...operationDetails,
        error: String(error),
        durationMs: Date.now() - started,
      }));
    } finally {
      await response?.dispose().catch(() => undefined);
    }
  }

  private assertion(
    url: string,
    message: string,
    severityHint: 'high' | 'medium' | 'low',
    details: Record<string, unknown>,
  ): QaEvent {
    return this.event('assertion', url, message, { severityHint, ...details });
  }

  private summary(enabled: boolean, mode: ApiMode): ApiQaSummary {
    return {
      enabled,
      mode,
      operationsDiscovered: 0,
      operationsTested: 0,
      operationsSkipped: 0,
      statefulOperationsTested: 0,
      statefulScenariosPlanned: 0,
      statefulScenariosCompleted: 0,
      cleanupAttempts: 0,
      cleanupFailures: 0,
    };
  }

  private event(kind: QaEvent['kind'], url: string, message: string, details?: Record<string, unknown>): QaEvent {
    return { timestamp: new Date().toISOString(), kind, url, message, details };
  }
}
