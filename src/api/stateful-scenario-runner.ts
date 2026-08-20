import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { QaEvent } from '../core/types.js';
import { JsonSchemaValidator } from './json-schema-validator.js';
import {
  contractForStatus,
  isStatusDeclared,
  planSandboxApiRequest,
  type ApiOperationModel,
} from './openapi-model.js';
import {
  operationKey,
  type StatefulApiScenario,
} from './stateful-scenario-planner.js';

export interface StatefulScenarioRunSummary {
  scenariosPlanned: number;
  scenariosCompleted: number;
  operationsTested: number;
  writeOperationsTested: number;
  cleanupAttempts: number;
  cleanupFailures: number;
  usedOperationKeys: string[];
}

export interface StatefulScenarioRunResult {
  events: QaEvent[];
  summary: StatefulScenarioRunSummary;
}

interface StepResult {
  status?: number;
  payload?: unknown;
  location?: string;
  failed: boolean;
}

function scalarId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= 300) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function itemUrl(scenario: StatefulApiScenario, id: string): string {
  return scenario.itemPath.replace(`{${scenario.idParameter}}`, encodeURIComponent(id));
}

function idFromLocation(location: string | undefined, origin: string, scenario: StatefulApiScenario): string | undefined {
  if (!location || !scenario.locationIdentityAllowed) return undefined;
  try {
    const parsed = new URL(location, origin);
    if (parsed.origin !== origin) return undefined;
    const collection = scenario.collectionPath.endsWith('/')
      ? scenario.collectionPath.slice(0, -1)
      : scenario.collectionPath;
    const prefix = `${collection}/`;
    if (!parsed.pathname.startsWith(prefix)) return undefined;
    const suffix = parsed.pathname.slice(prefix.length);
    if (!suffix || suffix.includes('/')) return undefined;
    const decoded = decodeURIComponent(suffix);
    return scalarId(decoded);
  } catch {
    return undefined;
  }
}

export class StatefulScenarioRunner {
  constructor(private readonly schemaValidator: JsonSchemaValidator = new JsonSchemaValidator()) {}

  async run(
    api: APIRequestContext,
    origin: string,
    scenarios: StatefulApiScenario[],
    operationBudget: number,
  ): Promise<StatefulScenarioRunResult> {
    const events: QaEvent[] = [];
    let scenariosCompleted = 0;
    let operationsTested = 0;
    let writeOperationsTested = 0;
    let cleanupAttempts = 0;
    let cleanupFailures = 0;
    const usedOperationKeys = new Set<string>();

    for (const scenario of scenarios) {
      if (operationsTested >= operationBudget) break;
      const minimumRequired = 2; // create + cleanup
      if (operationBudget - operationsTested < minimumRequired) break;

      for (const operation of [scenario.create, scenario.read, scenario.update, scenario.cleanup]) {
        if (operation) usedOperationKeys.add(operationKey(operation));
      }

      events.push(this.event('snapshot', new URL(scenario.collectionPath, origin).toString(), 'Stateful sandbox lifecycle started', {
        api: true,
        sandbox: true,
        stateful: true,
        scenarioId: scenario.id,
        collectionPath: scenario.collectionPath,
        itemPath: scenario.itemPath,
        identityProperty: scenario.identityProperty,
        locationIdentityAllowed: scenario.locationIdentityAllowed,
      }));

      let createdId: string | undefined;
      let identitySource: 'body' | 'location' | undefined;
      let scenarioFailed = false;
      try {
        const createPlan = planSandboxApiRequest(scenario.create);
        if (!createPlan.relativeUrl || createPlan.body === undefined) {
          scenarioFailed = true;
          events.push(this.telemetry(origin, scenario, 'create', 'Stateful lifecycle create planning became unavailable'));
          continue;
        }

        const create = await this.step(api, origin, scenario, 'create', scenario.create, createPlan.relativeUrl, createPlan.body, events);
        operationsTested += 1;
        writeOperationsTested += 1;
        if (create.failed || create.status === undefined || create.status < 200 || create.status >= 300) {
          scenarioFailed = true;
          continue;
        }

        const objectPayload = create.payload && typeof create.payload === 'object' && !Array.isArray(create.payload)
          ? create.payload as Record<string, unknown>
          : undefined;
        if (scenario.identityProperty) {
          createdId = scalarId(objectPayload?.[scenario.identityProperty]);
          if (createdId) identitySource = 'body';
        }
        if (!createdId) {
          createdId = idFromLocation(create.location, origin, scenario);
          if (createdId) identitySource = 'location';
        }

        if (!createdId) {
          scenarioFailed = true;
          events.push(this.assertion(
            new URL(scenario.collectionPath, origin).toString(),
            'Sandbox create response did not expose a safe identity required for cleanup',
            'high',
            scenario,
            'create',
            {
              identityProperty: scenario.identityProperty,
              locationIdentityAllowed: scenario.locationIdentityAllowed,
              locationPresent: Boolean(create.location),
            },
          ));
          continue;
        }

        const dynamicUrl = itemUrl(scenario, createdId);
        events.push(this.event('snapshot', new URL(dynamicUrl, origin).toString(), 'Stateful lifecycle bound the newly created resource identity', {
          api: true,
          sandbox: true,
          stateful: true,
          scenarioId: scenario.id,
          statefulStep: 'bind-id',
          identityProperty: scenario.identityProperty,
          identitySource,
          identityCaptured: true,
        }));

        // Once a resource identity exists, one budget slot is permanently reserved
        // for DELETE cleanup. Optional verification/update steps may never consume it.
        if (scenario.read && operationsTested < operationBudget - 1) {
          const read = await this.step(api, origin, scenario, 'verify-create', scenario.read, dynamicUrl, undefined, events);
          operationsTested += 1;
          if (read.failed || (read.status !== undefined && read.status >= 400)) scenarioFailed = true;
        }

        if (scenario.update && operationsTested < operationBudget - 1) {
          const updatePlan = planSandboxApiRequest({
            ...scenario.update,
            parameters: scenario.update.parameters.map((parameter) =>
              parameter.location === 'path' && parameter.name === scenario.idParameter
                ? { ...parameter, example: createdId }
                : parameter,
            ),
          });
          if (updatePlan.relativeUrl && updatePlan.body !== undefined) {
            const update = await this.step(api, origin, scenario, 'update', scenario.update, dynamicUrl, updatePlan.body, events);
            operationsTested += 1;
            writeOperationsTested += 1;
            if (update.failed || (update.status !== undefined && update.status >= 400)) scenarioFailed = true;

            if (scenario.read && operationsTested < operationBudget - 1) {
              const reread = await this.step(api, origin, scenario, 'verify-update', scenario.read, dynamicUrl, undefined, events);
              operationsTested += 1;
              if (reread.failed || (reread.status !== undefined && reread.status >= 400)) scenarioFailed = true;
            }
          }
        }
      } finally {
        if (createdId) {
          cleanupAttempts += 1;
          const dynamicUrl = itemUrl(scenario, createdId);
          const cleanup = await this.step(api, origin, scenario, 'cleanup', scenario.cleanup, dynamicUrl, undefined, events);
          operationsTested += 1;
          writeOperationsTested += 1;
          if (cleanup.failed || cleanup.status === undefined || cleanup.status < 200 || cleanup.status >= 300) {
            cleanupFailures += 1;
            scenarioFailed = true;
            events.push(this.assertion(
              new URL(dynamicUrl, origin).toString(),
              `Sandbox lifecycle cleanup failed for newly created resource: DELETE ${dynamicUrl}`,
              'high',
              scenario,
              'cleanup',
              { cleanupStatus: cleanup.status },
            ));
          } else if (scenario.read && operationsTested < operationBudget) {
            const verifyDelete = await this.step(api, origin, scenario, 'verify-cleanup', scenario.read, dynamicUrl, undefined, events, true);
            operationsTested += 1;
            events.push(this.event('snapshot', new URL(dynamicUrl, origin).toString(), 'Stateful lifecycle post-cleanup verification completed', {
              api: true,
              sandbox: true,
              stateful: true,
              scenarioId: scenario.id,
              statefulStep: 'verify-cleanup',
              status: verifyDelete.status,
              resourceStillReadable: verifyDelete.status !== undefined && verifyDelete.status >= 200 && verifyDelete.status < 300,
            }));
          }
        }
      }

      if (!scenarioFailed && createdId) scenariosCompleted += 1;
    }

    return {
      events,
      summary: {
        scenariosPlanned: scenarios.length,
        scenariosCompleted,
        operationsTested,
        writeOperationsTested,
        cleanupAttempts,
        cleanupFailures,
        usedOperationKeys: [...usedOperationKeys],
      },
    };
  }

  private async step(
    api: APIRequestContext,
    origin: string,
    scenario: StatefulApiScenario,
    stepName: string,
    operation: ApiOperationModel,
    relativeUrl: string,
    body: unknown,
    events: QaEvent[],
    allowExpectedMissing = false,
  ): Promise<StepResult> {
    const absoluteUrl = new URL(relativeUrl, origin).toString();
    const started = Date.now();
    const details = {
      api: true,
      sandbox: true,
      stateful: true,
      scenarioId: scenario.id,
      statefulStep: stepName,
      method: operation.method,
      path: operation.path,
      relativeUrl,
      operationId: operation.operationId,
      requestBodyUsed: body !== undefined,
    };
    events.push(this.event('action', absoluteUrl, `Stateful API ${stepName}: ${operation.method} ${relativeUrl}`, details));

    let response: APIResponse | undefined;
    try {
      response = await api.fetch(relativeUrl, {
        method: operation.method,
        data: body,
        timeout: 10_000,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      const status = response.status();
      const headers = response.headers();
      const contentType = headers['content-type'] ?? '';
      const location = headers.location;
      const contract = contractForStatus(operation, status);
      events.push(this.event('snapshot', absoluteUrl, `Stateful API ${stepName} response: ${status}`, {
        ...details,
        status,
        durationMs: Date.now() - started,
        contentType,
        declaredStatus: isStatusDeclared(operation, status),
        locationPresent: Boolean(location),
      }));

      if (!allowExpectedMissing && status >= 500) {
        events.push(this.assertion(absoluteUrl, `Stateful API step returned server error ${status}: ${operation.method} ${relativeUrl}`, 'high', scenario, stepName, { status }));
      } else if (!allowExpectedMissing && operation.responses.length > 0 && !isStatusDeclared(operation, status)) {
        events.push(this.assertion(absoluteUrl, `Stateful API step returned undeclared status ${status}: ${operation.method} ${relativeUrl}`, 'medium', scenario, stepName, { status }));
      }

      let payload: unknown;
      if (contract?.expectsJson && operation.method !== 'HEAD' && /json/i.test(contentType)) {
        try {
          payload = await response.json();
        } catch {
          if (!allowExpectedMissing) {
            events.push(this.assertion(absoluteUrl, `Stateful API response declares JSON but body could not be parsed: ${operation.method} ${relativeUrl}`, 'medium', scenario, stepName, { status }));
          }
        }
        if (payload !== undefined && contract.schema !== undefined && !allowExpectedMissing) {
          const validation = this.schemaValidator.validate(contract.schema, payload);
          if (!validation.toolingError && !validation.valid) {
            events.push(this.assertion(absoluteUrl, `Stateful API response violates OpenAPI schema: ${operation.method} ${relativeUrl}`, 'medium', scenario, stepName, {
              status,
              schemaIssues: validation.issues,
            }));
          }
        }
      }

      return { status, payload, location, failed: false };
    } catch (error: unknown) {
      events.push(this.assertion(absoluteUrl, `Stateful API step failed to complete: ${operation.method} ${relativeUrl}`, 'medium', scenario, stepName, {
        error: String(error),
        durationMs: Date.now() - started,
      }));
      return { failed: true };
    } finally {
      await response?.dispose().catch(() => undefined);
    }
  }

  private assertion(
    url: string,
    message: string,
    severityHint: 'high' | 'medium' | 'low',
    scenario: StatefulApiScenario,
    stepName: string,
    details?: Record<string, unknown>,
  ): QaEvent {
    return this.event('assertion', url, message, {
      api: true,
      sandbox: true,
      stateful: true,
      scenarioId: scenario.id,
      statefulStep: stepName,
      severityHint,
      ...details,
    });
  }

  private telemetry(origin: string, scenario: StatefulApiScenario, stepName: string, message: string): QaEvent {
    return this.event('snapshot', origin, message, {
      api: true,
      sandbox: true,
      stateful: true,
      scenarioId: scenario.id,
      statefulStep: stepName,
    });
  }

  private event(kind: QaEvent['kind'], url: string, message: string, details?: Record<string, unknown>): QaEvent {
    return { timestamp: new Date().toISOString(), kind, url, message, details };
  }
}
