import { describe, expect, it, vi } from 'vitest';
import { planStatefulApiScenarios } from '../src/api/stateful-scenario-planner.js';
import { StatefulScenarioRunner } from '../src/api/stateful-scenario-runner.js';

const locationDocument = {
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
            description: 'created',
            headers: {
              Location: { schema: { type: 'string' } },
            },
          },
        },
      },
    },
    '/api/items/{id}': {
      delete: {
        operationId: 'deleteItem',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: 'deleted' } },
      },
    },
  },
};

function response(status: number, headers: Record<string, string> = {}) {
  return {
    status: () => status,
    headers: () => headers,
    json: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe('stateful Location identity', () => {
  it('forms and completes a cleanup-safe lifecycle from a declared same-origin Location header', async () => {
    const scenarios = planStatefulApiScenarios(locationDocument);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toMatchObject({
      identityProperty: undefined,
      locationIdentityAllowed: true,
      itemPath: '/api/items/{id}',
    });

    const fetch = vi.fn()
      .mockResolvedValueOnce(response(201, { location: '/api/items/73' }))
      .mockResolvedValueOnce(response(204));
    const api = { fetch } as any;
    const result = await new StatefulScenarioRunner().run(api, 'https://example.test', scenarios, 2);

    expect(result.summary).toMatchObject({
      scenariosPlanned: 1,
      scenariosCompleted: 1,
      operationsTested: 2,
      cleanupAttempts: 1,
      cleanupFailures: 0,
    });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual(['/api/items', '/api/items/73']);
    expect(result.events.some((event) => event.details?.identitySource === 'location')).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain('/api/items/73?');
  });

  it('rejects a cross-origin Location and never sends cleanup to that target', async () => {
    const scenarios = planStatefulApiScenarios(locationDocument);
    const fetch = vi.fn().mockResolvedValueOnce(response(201, { location: 'https://evil.test/api/items/73' }));
    const api = { fetch } as any;
    const result = await new StatefulScenarioRunner().run(api, 'https://example.test', scenarios, 2);

    expect(result.summary).toMatchObject({ scenariosCompleted: 0, cleanupAttempts: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const assertion = result.events.find((event) => event.kind === 'assertion');
    expect(assertion?.message).toContain('did not expose a safe identity');
    expect(assertion?.details?.severityHint).toBe('high');
  });

  it('does not form a Location-only lifecycle unless the successful response declares Location', () => {
    const document = structuredClone(locationDocument) as any;
    delete document.paths['/api/items'].post.responses['201'].headers;
    expect(planStatefulApiScenarios(document)).toHaveLength(0);
  });
});
