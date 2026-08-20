import { describe, expect, it } from 'vitest';
import {
  contractForStatus,
  isStatusDeclared,
  parseOpenApiOperations,
  planSafeApiRequest,
  type ApiOperationModel,
} from '../src/api/openapi-model.js';

const document = {
  openapi: '3.1.0',
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [
          { name: 'id', in: 'path', required: true, example: 42 },
          { name: 'include', in: 'query', required: true, schema: { default: 'profile' } },
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { type: 'object', required: ['id', 'name'] },
              },
            },
          },
          '4XX': { description: 'client error' },
        },
      },
    },
    '/auth/logout': {
      get: {
        operationId: 'logout',
        responses: { '204': { description: 'done' } },
      },
    },
    '/legacy/session': {
      get: {
        operationId: 'resetPasswordForUser',
        responses: { '200': { description: 'legacy mutating GET' } },
      },
    },
    '/orders/{orderId}': {
      get: {
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/admin': {
      post: { responses: { '200': { description: 'write operation' } } },
    },
  },
};

describe('OpenAPI safe operation model', () => {
  it('inventories only read-only GET/HEAD operations', () => {
    const operations = parseOpenApiOperations(document);
    expect(operations.map((operation) => `${operation.method} ${operation.path}`)).toEqual([
      'GET /auth/logout',
      'GET /legacy/session',
      'GET /orders/{orderId}',
      'GET /users/{id}',
    ]);
  });

  it('uses explicit examples/defaults to build a safe request', () => {
    const operation = parseOpenApiOperations(document).find((item) => item.operationId === 'getUser')!;
    const planned = planSafeApiRequest(operation);
    expect(planned.relativeUrl).toBe('/users/42?include=profile');
    expect(planned.skippedReason).toBeUndefined();
  });

  it('blocks suspicious state-changing GET operations by path or operation id', () => {
    const operations = parseOpenApiOperations(document);
    const logout = operations.find((item) => item.operationId === 'logout')!;
    const resetPassword = operations.find((item) => item.operationId === 'resetPasswordForUser')!;
    expect(planSafeApiRequest(logout).skippedReason).toMatch(/state-changing|session-ending/);
    expect(planSafeApiRequest(resetPassword).skippedReason).toMatch(/state-changing|session-ending/);
  });

  it('rejects absolute and protocol-relative paths before request construction', () => {
    const base: Omit<ApiOperationModel, 'path'> = {
      method: 'GET',
      operationId: 'readExternal',
      parameters: [],
      responses: [],
    };
    expect(planSafeApiRequest({ ...base, path: 'https://evil.example/data' }).skippedReason).toContain('same-origin');
    expect(planSafeApiRequest({ ...base, path: '//evil.example/data' }).skippedReason).toContain('same-origin');
  });

  it('skips required path parameters without an explicit safe example', () => {
    const operation = parseOpenApiOperations(document).find((item) => item.path.includes('orders'))!;
    expect(planSafeApiRequest(operation).skippedReason).toContain('has no example');
  });

  it('matches exact and wildcard response contracts', () => {
    const operation = parseOpenApiOperations(document).find((item) => item.operationId === 'getUser')!;
    expect(isStatusDeclared(operation, 200)).toBe(true);
    expect(isStatusDeclared(operation, 404)).toBe(true);
    expect(isStatusDeclared(operation, 500)).toBe(false);
    expect(contractForStatus(operation, 200)?.requiredProperties).toEqual(['id', 'name']);
    expect(contractForStatus(operation, 200)?.expectsJson).toBe(true);
  });
});
