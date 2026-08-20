import { describe, expect, it } from 'vitest';
import { operationKey, planStatefulApiScenarios } from '../src/api/stateful-scenario-planner.js';

const lifecycleDocument = {
  openapi: '3.1.0',
  paths: {
    '/api/items': {
      post: {
        operationId: 'createItem',
        requestBody: {
          required: true,
          content: { 'application/json': { example: { name: 'sandbox-item' } } },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'name'],
                  properties: { id: { type: 'integer' }, name: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/api/items/{id}': {
      get: {
        operationId: 'getItem',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'ok' } },
      },
      patch: {
        operationId: 'updateItem',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { example: { name: 'updated' } } },
        },
        responses: { '200': { description: 'updated' } },
      },
      delete: {
        operationId: 'deleteItem',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '204': { description: 'deleted' } },
      },
    },
  },
};

describe('stateful API scenario planner', () => {
  it('forms a lifecycle only when create returns a required identity and cleanup exists', () => {
    const scenarios = planStatefulApiScenarios(lifecycleDocument);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toMatchObject({
      collectionPath: '/api/items',
      itemPath: '/api/items/{id}',
      idParameter: 'id',
      identityProperty: 'id',
    });
    expect(operationKey(scenarios[0]!.create)).toBe('POST /api/items');
    expect(operationKey(scenarios[0]!.read!)).toBe('GET /api/items/{id}');
    expect(operationKey(scenarios[0]!.update!)).toBe('PATCH /api/items/{id}');
    expect(operationKey(scenarios[0]!.cleanup)).toBe('DELETE /api/items/{id}');
  });

  it('refuses a lifecycle if DELETE cleanup is unavailable', () => {
    const document = structuredClone(lifecycleDocument);
    delete (document.paths['/api/items/{id}'] as Record<string, unknown>).delete;
    expect(planStatefulApiScenarios(document)).toHaveLength(0);
  });

  it('refuses a lifecycle if the create response does not guarantee an identity property', () => {
    const document = structuredClone(lifecycleDocument);
    const post = document.paths['/api/items'].post;
    post.responses['201'].content['application/json'].schema.required = ['name'];
    expect(planStatefulApiScenarios(document)).toHaveLength(0);
  });

  it('refuses permanently blocked collection endpoints', () => {
    const source = structuredClone(lifecycleDocument) as unknown as { openapi: string; paths: Record<string, unknown> };
    const collection = source.paths['/api/items'];
    const item = source.paths['/api/items/{id}'];
    source.paths = {
      '/api/payments': collection,
      '/api/payments/{id}': item,
    };
    expect(planStatefulApiScenarios(source)).toHaveLength(0);
  });
});
