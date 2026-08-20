import {
  parseOpenApiOperations,
  parseOpenApiWriteOperations,
  planSafeApiRequest,
  planSandboxApiRequest,
  type ApiOperationModel,
} from './openapi-model.js';

export interface StatefulApiScenario {
  id: string;
  collectionPath: string;
  itemPath: string;
  idParameter: string;
  identityProperty?: string;
  locationIdentityAllowed: boolean;
  create: ApiOperationModel;
  read?: ApiOperationModel;
  update?: ApiOperationModel;
  cleanup: ApiOperationModel;
}

const DYNAMIC_ID_SENTINEL = 'AIQA_CREATED_RESOURCE_ID';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function itemTemplateFor(collectionPath: string, candidatePath: string): string | undefined {
  const normalized = collectionPath.endsWith('/') ? collectionPath.slice(0, -1) : collectionPath;
  const prefix = `${normalized}/`;
  if (!candidatePath.startsWith(prefix)) return undefined;
  const suffix = candidatePath.slice(prefix.length);
  const match = /^\{([^}]+)\}$/.exec(suffix);
  return match?.[1];
}

function responseIdentityProperty(operation: ApiOperationModel, idParameter: string): string | undefined {
  const preferred = [idParameter, 'id'];
  for (const response of operation.responses) {
    if (!/^(?:2\d\d|2XX)$/.test(response.statusPattern) || !response.expectsJson) continue;
    const schema = record(response.schema);
    const properties = record(schema?.properties);
    const required = Array.isArray(schema?.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [];
    for (const name of preferred) {
      if (properties?.[name] !== undefined && required.includes(name)) return name;
    }
  }
  return undefined;
}

function responseDeclaresLocation(document: unknown, operation: ApiOperationModel): boolean {
  const root = record(document);
  const paths = record(root?.paths);
  const pathItem = record(paths?.[operation.path]);
  const sourceOperation = record(pathItem?.[operation.method.toLowerCase()]);
  const responses = record(sourceOperation?.responses);
  if (!responses) return false;

  for (const [status, responseValue] of Object.entries(responses)) {
    if (!/^(?:2\d\d|2XX)$/i.test(status)) continue;
    const response = record(responseValue);
    const headers = record(response?.headers);
    if (headers && Object.keys(headers).some((name) => name.toLowerCase() === 'location')) return true;
  }
  return false;
}

function bindCreatedId(operation: ApiOperationModel, idParameter: string): ApiOperationModel {
  return {
    ...operation,
    parameters: operation.parameters.map((parameter) =>
      parameter.location === 'path' && parameter.name === idParameter
        ? { ...parameter, example: DYNAMIC_ID_SENTINEL }
        : parameter,
    ),
  };
}

function safeWithCreatedId(operation: ApiOperationModel, idParameter: string): boolean {
  const planned = planSafeApiRequest(bindCreatedId(operation, idParameter));
  return Boolean(planned.relativeUrl);
}

function sandboxWithCreatedId(operation: ApiOperationModel, idParameter: string): boolean {
  const planned = planSandboxApiRequest(bindCreatedId(operation, idParameter));
  return Boolean(planned.relativeUrl);
}

export function operationKey(operation: ApiOperationModel): string {
  return `${operation.method} ${operation.path}`;
}

export function planStatefulApiScenarios(document: unknown): StatefulApiScenario[] {
  const reads = parseOpenApiOperations(document);
  const writes = parseOpenApiWriteOperations(document);
  const creates = writes.filter((operation) => operation.method === 'POST' && !operation.path.includes('{'));
  const scenarios: StatefulApiScenario[] = [];

  for (const create of creates) {
    const createPlan = planSandboxApiRequest(create);
    if (!createPlan.relativeUrl || createPlan.body === undefined) continue;

    const itemPaths = [...new Set(writes.map((operation) => operation.path).concat(reads.map((operation) => operation.path)))];
    for (const itemPath of itemPaths) {
      const idParameter = itemTemplateFor(create.path, itemPath);
      if (!idParameter) continue;

      const cleanup = writes.find((operation) => operation.method === 'DELETE' && operation.path === itemPath);
      if (!cleanup || !sandboxWithCreatedId(cleanup, idParameter)) continue;

      const identityProperty = responseIdentityProperty(create, idParameter);
      const locationIdentityAllowed = responseDeclaresLocation(document, create);
      if (!identityProperty && !locationIdentityAllowed) continue;

      const read = reads.find((operation) => operation.method === 'GET' && operation.path === itemPath);
      const update = writes.find((operation) => operation.method === 'PATCH' && operation.path === itemPath);
      const usableRead = read && safeWithCreatedId(read, idParameter) ? read : undefined;
      const usableUpdate = update && sandboxWithCreatedId(update, idParameter) ? update : undefined;

      scenarios.push({
        id: `lifecycle:${create.operationId ?? create.path}:${itemPath}`,
        collectionPath: create.path,
        itemPath,
        idParameter,
        identityProperty,
        locationIdentityAllowed,
        create,
        read: usableRead,
        update: usableUpdate,
        cleanup,
      });
      break;
    }
  }

  return scenarios.slice(0, 20);
}
