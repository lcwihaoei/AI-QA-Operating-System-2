import { describe, expect, it } from 'vitest';
import {
  parseOpenApiWriteOperations,
  planSandboxApiRequest,
} from '../src/api/openapi-model.js';

const document = {
  openapi: '3.1.0',
  paths: {
    '/api/items': {
      post: {
        operationId: 'createItem',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { name: 'sandbox-item' },
            },
          },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/api/items/{id}': {
      patch: {
        operationId: 'updateItem',
        parameters: [{ name: 'id', in: 'path', required: true, example: 42 }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', example: { name: 'updated' } },
            },
          },
        },
        responses: { '200': { description: 'updated' } },
      },
      delete: {
        operationId: 'deleteItem',
        parameters: [{ name: 'id', in: 'path', required: true, example: 42 }],
        responses: { '204': { description: 'deleted' } },
      },
    },
    '/api/no-example': {
      post: {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/api/payments': {
      post: {
        operationId: 'createPayment',
        requestBody: {
          required: true,
          content: { 'application/json': { example: { amount: 1 } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
  },
};

describe('sandbox OpenAPI request planning', () => {
  it('inventories write methods separately from safe reads', () => {
    const operations = parseOpenApiWriteOperations(document);
    expect(operations.map((item) => `${item.method} ${item.path}`)).toEqual([
      'POST /api/items',
      'DELETE /api/items/{id}',
      'PATCH /api/items/{id}',
      'POST /api/no-example',
      'POST /api/payments',
    ]);
  });

  it('uses only explicit OpenAPI body examples and explicit parameter examples', () => {
    const operations = parseOpenApiWriteOperations(document);
    const create = planSandboxApiRequest(operations.find((item) => item.operationId === 'createItem')!);
    const update = planSandboxApiRequest(operations.find((item) => item.operationId === 'updateItem')!);
    const remove = planSandboxApiRequest(operations.find((item) => item.operationId === 'deleteItem')!);

    expect(create.relativeUrl).toBe('/api/items');
    expect(create.body).toEqual({ name: 'sandbox-item' });
    expect(update.relativeUrl).toBe('/api/items/42');
    expect(update.body).toEqual({ name: 'updated' });
    expect(remove.relativeUrl).toBe('/api/items/42');
    expect(remove.body).toBeUndefined();
  });

  it('skips required request bodies when no explicit example/default/enum exists', () => {
    const operation = parseOpenApiWriteOperations(document).find((item) => item.path === '/api/no-example')!;
    expect(planSandboxApiRequest(operation).skippedReason).toContain('no explicit OpenAPI example');
  });

  it('permanently blocks financial/external-side-effect endpoints even in sandbox', () => {
    const operation = parseOpenApiWriteOperations(document).find((item) => item.path === '/api/payments')!;
    expect(planSandboxApiRequest(operation).skippedReason).toContain('permanently blocked');
  });
});
