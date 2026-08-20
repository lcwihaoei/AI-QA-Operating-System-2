export type ApiReadMethod = 'GET' | 'HEAD';
export type ApiWriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ApiMethod = ApiReadMethod | ApiWriteMethod;

export interface ApiParameterModel {
  name: string;
  location: 'path' | 'query';
  required: boolean;
  example?: unknown;
  defaultValue?: unknown;
  enumValues?: unknown[];
}

export interface ApiRequestBodyModel {
  required: boolean;
  mediaType: 'application/json';
  example?: unknown;
}

export interface ApiResponseContract {
  statusPattern: string;
  expectsJson: boolean;
  requiredProperties: string[];
  schema?: unknown;
}

export interface ApiOperationModel {
  method: ApiMethod;
  path: string;
  operationId?: string;
  parameters: ApiParameterModel[];
  requestBody?: ApiRequestBodyModel;
  responses: ApiResponseContract[];
}

export interface PlannedApiRequest {
  operation: ApiOperationModel;
  relativeUrl?: string;
  body?: unknown;
  skippedReason?: string;
}

type JsonRecord = Record<string, unknown>;

const READ_METHODS = new Set(['get', 'head']);
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const DANGEROUS_READ_PATTERN = /(?:^|[^a-z0-9])(delete|destroy|remove|logout|log-out|signout|sign-out|purge|terminate|revoke|unsubscribe|reset-password|reset-account|cancel-subscription)(?:$|[^a-z0-9])/i;
const SANDBOX_ALWAYS_BLOCKED_PATTERN = /(?:^|[^a-z0-9])(payments?|billing|charges?|transfers?|payouts?|withdraw(?:al)?s?|deposits?|deploy(?:ment)?s?|production|secrets?|tokens?|credentials?|webhooks?|emails?|sms|notifications?)(?:$|[^a-z0-9])/i;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rewriteComponentRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteComponentRefs);
  const source = record(value);
  if (!source) return value;
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')) {
      out[key] = `#/$defs/${child.slice('#/components/schemas/'.length)}`;
    } else {
      out[key] = rewriteComponentRefs(child);
    }
  }
  return out;
}

function standaloneResponseSchema(root: JsonRecord | undefined, value: unknown): unknown {
  if (value === undefined) return undefined;
  const rewritten = rewriteComponentRefs(value);
  const schema = record(rewritten);
  if (!schema) return rewritten;

  const components = record(root?.components);
  const componentSchemas = record(components?.schemas);
  if (!componentSchemas || Object.keys(componentSchemas).length === 0) return schema;

  const existingDefs = record(schema.$defs) ?? {};
  const componentDefs = Object.fromEntries(
    Object.entries(componentSchemas).map(([name, component]) => [name, rewriteComponentRefs(component)]),
  );
  return {
    ...schema,
    $defs: {
      ...existingDefs,
      ...componentDefs,
    },
  };
}

function parameterModel(value: unknown): ApiParameterModel | undefined {
  const source = record(value);
  if (!source || typeof source.name !== 'string') return undefined;
  if (source.in !== 'path' && source.in !== 'query') return undefined;
  const schema = record(source.schema);
  return {
    name: source.name,
    location: source.in,
    required: source.in === 'path' || source.required === true,
    example: source.example ?? schema?.example,
    defaultValue: schema?.default,
    enumValues: array(schema?.enum),
  };
}

function requestBodyModel(value: unknown): ApiRequestBodyModel | undefined {
  const body = record(value);
  if (!body) return undefined;
  const content = record(body.content);
  const jsonEntry = content
    ? Object.entries(content).find(([mediaType]) => /(^|[+/])json(?:$|;)/i.test(mediaType))
    : undefined;
  if (!jsonEntry) return undefined;
  const media = record(jsonEntry[1]);
  const schema = record(media?.schema);
  return {
    required: body.required === true,
    mediaType: 'application/json',
    example: media?.example ?? schema?.example ?? schema?.default ?? array(schema?.enum)[0],
  };
}

function responseContract(root: JsonRecord | undefined, statusPattern: string, value: unknown): ApiResponseContract {
  const response = record(value);
  const content = record(response?.content);
  const jsonContent = content
    ? Object.entries(content).find(([mediaType]) => /(^|[+/])json(?:$|;)/i.test(mediaType))?.[1]
    : undefined;
  const rawSchema = record(jsonContent)?.schema;
  const schemaRecord = record(rawSchema);
  const requiredProperties = array(schemaRecord?.required).filter((item): item is string => typeof item === 'string');
  return {
    statusPattern: statusPattern.toUpperCase(),
    expectsJson: Boolean(jsonContent),
    requiredProperties,
    schema: standaloneResponseSchema(root, rawSchema),
  };
}

function parseOperations(document: unknown, allowedMethods: Set<string>): ApiOperationModel[] {
  const root = record(document);
  const paths = record(root?.paths);
  if (!paths) return [];

  const operations: ApiOperationModel[] = [];
  for (const [pathName, pathValue] of Object.entries(paths)) {
    const pathItem = record(pathValue);
    if (!pathItem) continue;
    const inheritedParameters = array(pathItem.parameters).map(parameterModel).filter((item): item is ApiParameterModel => Boolean(item));

    for (const [methodName, operationValue] of Object.entries(pathItem)) {
      if (!allowedMethods.has(methodName.toLowerCase())) continue;
      const operation = record(operationValue);
      if (!operation) continue;
      const ownParameters = array(operation.parameters).map(parameterModel).filter((item): item is ApiParameterModel => Boolean(item));
      const merged = new Map<string, ApiParameterModel>();
      for (const parameter of [...inheritedParameters, ...ownParameters]) {
        merged.set(`${parameter.location}:${parameter.name}`, parameter);
      }
      const responses = record(operation.responses);
      operations.push({
        method: methodName.toUpperCase() as ApiMethod,
        path: pathName,
        operationId: typeof operation.operationId === 'string' ? operation.operationId : undefined,
        parameters: [...merged.values()],
        requestBody: requestBodyModel(operation.requestBody),
        responses: responses
          ? Object.entries(responses).map(([status, response]) => responseContract(root, status, response))
          : [],
      });
    }
  }

  return operations.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
}

export function parseOpenApiOperations(document: unknown): ApiOperationModel[] {
  return parseOperations(document, READ_METHODS);
}

export function parseOpenApiWriteOperations(document: unknown): ApiOperationModel[] {
  return parseOperations(document, WRITE_METHODS);
}

function exampleValue(parameter: ApiParameterModel): unknown {
  if (parameter.example !== undefined) return parameter.example;
  if (parameter.defaultValue !== undefined) return parameter.defaultValue;
  return parameter.enumValues?.[0];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function operationSafetyIdentity(operation: ApiOperationModel): string {
  return `${operation.path} ${operation.operationId ?? ''}`
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2');
}

function isSameOriginRelativePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

function planParameters(operation: ApiOperationModel): { relativeUrl?: string; skippedReason?: string } {
  if (!isSameOriginRelativePath(operation.path)) {
    return { skippedReason: 'operation path is not a same-origin absolute-path reference' };
  }

  let relativeUrl = operation.path;
  const query = new URLSearchParams();
  for (const parameter of operation.parameters) {
    if (!parameter.required) continue;
    const raw = exampleValue(parameter);
    const value = stringValue(raw);
    if (value === undefined) {
      return { skippedReason: `required ${parameter.location} parameter ${parameter.name} has no example/default/enum value` };
    }
    if (parameter.location === 'path') {
      relativeUrl = relativeUrl.replaceAll(`{${parameter.name}}`, encodeURIComponent(value));
    } else {
      query.set(parameter.name, value);
    }
  }

  if (/\{[^}]+\}/.test(relativeUrl)) {
    return { skippedReason: 'path contains unresolved template parameters' };
  }
  const serialized = query.toString();
  return { relativeUrl: serialized ? `${relativeUrl}?${serialized}` : relativeUrl };
}

export function planSafeApiRequest(operation: ApiOperationModel): PlannedApiRequest {
  const params = planParameters(operation);
  if (!params.relativeUrl) return { operation, skippedReason: params.skippedReason };

  if (DANGEROUS_READ_PATTERN.test(operationSafetyIdentity(operation))) {
    return { operation, skippedReason: 'operation name/path suggests a state-changing or session-ending action' };
  }
  return { operation, relativeUrl: params.relativeUrl };
}

export function planSandboxApiRequest(operation: ApiOperationModel): PlannedApiRequest {
  const params = planParameters(operation);
  if (!params.relativeUrl) return { operation, skippedReason: params.skippedReason };

  if (SANDBOX_ALWAYS_BLOCKED_PATTERN.test(operationSafetyIdentity(operation))) {
    return { operation, skippedReason: 'operation is permanently blocked because it may cause financial, deployment, credential, messaging, or external side effects' };
  }

  if (operation.requestBody?.required && operation.requestBody.example === undefined) {
    return { operation, skippedReason: 'required JSON request body has no explicit OpenAPI example/default/enum value' };
  }

  return {
    operation,
    relativeUrl: params.relativeUrl,
    body: operation.requestBody?.example,
  };
}

export function contractForStatus(operation: ApiOperationModel, status: number): ApiResponseContract | undefined {
  const exact = String(status);
  const wildcard = `${Math.floor(status / 100)}XX`;
  return operation.responses.find((response) => response.statusPattern === exact)
    ?? operation.responses.find((response) => response.statusPattern === wildcard)
    ?? operation.responses.find((response) => response.statusPattern === 'DEFAULT');
}

export function isStatusDeclared(operation: ApiOperationModel, status: number): boolean {
  return Boolean(contractForStatus(operation, status));
}
