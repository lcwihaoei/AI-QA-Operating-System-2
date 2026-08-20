import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  newContext: vi.fn(),
  launch: vi.fn(),
}));

vi.mock('@playwright/test', () => ({
  request: { newContext: runtime.newContext },
  chromium: { launch: runtime.launch },
}));

import { SemanticStateAgent } from '../src/agents/semantic-state-agent.js';
import { findingsFromEvents } from '../src/reporting/bug-reporter.js';

function apiResponse(options: {
  status?: number;
  contentType?: string;
  text?: string;
  json?: unknown;
}) {
  return {
    status: () => options.status ?? 200,
    headers: () => ({ 'content-type': options.contentType ?? 'application/json' }),
    text: vi.fn().mockResolvedValue(options.text ?? JSON.stringify(options.json ?? {})),
    json: vi.fn().mockResolvedValue(options.json ?? {}),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

const openapi = {
  openapi: '3.1.0',
  paths: {
    '/api/profile': {
      get: {
        operationId: 'getProfile',
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    displayName: { type: 'string' },
                    token: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

function installRuntime(uiValue: string): void {
  const schemaResponse = apiResponse({ text: JSON.stringify(openapi) });
  const profileResponse = apiResponse({ json: { displayName: 'Lee', token: 'never-persist-this' } });
  const notFound = apiResponse({ status: 404, text: 'not found', contentType: 'text/plain' });
  const api = {
    get: vi.fn().mockImplementation(async (path: string) => {
      if (path === '/openapi.json') return schemaResponse;
      if (path === '/api/profile') return profileResponse;
      return notFound;
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  runtime.newContext.mockResolvedValue(api);

  const page = {
    goto: vi.fn().mockResolvedValue({}),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({
      evaluateAll: vi.fn().mockResolvedValue([
        {
          visible: true,
          identities: ['displayName', 'Display Name'],
          value: uiValue,
          type: 'text',
          autocomplete: '',
          formAction: 'https://example.test/api/profile',
        },
        {
          visible: true,
          identities: ['creditCard', 'Card number'],
          value: '4111111111111111',
          type: 'text',
          autocomplete: 'cc-number',
          formAction: 'https://example.test/api/profile',
        },
      ]),
    }),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  runtime.launch.mockResolvedValue(browser);
}

beforeEach(() => {
  runtime.newContext.mockReset();
  runtime.launch.mockReset();
});

describe('SemanticStateAgent', () => {
  it('reports a scoped API/UI mismatch without persisting raw values', async () => {
    installRuntime('Old Name');
    const result = await new SemanticStateAgent().run({
      url: 'https://example.test',
      visitedUrls: ['https://example.test/settings'],
      maxOperations: 10,
    });

    expect(result.summary).toMatchObject({
      apiFactsObserved: 1,
      uiFieldsObserved: 1,
      comparisons: 1,
      matches: 0,
      mismatches: 1,
    });
    const mismatch = result.events.find((event) => event.kind === 'assertion');
    expect(mismatch?.details).toMatchObject({
      semanticState: true,
      semanticVerdict: 'mismatch',
      fieldKey: 'displayName',
      apiPath: '/api/profile',
      valuesHashed: true,
    });

    const serialized = JSON.stringify(result.events);
    expect(serialized).not.toContain('Old Name');
    expect(serialized).not.toContain('never-persist-this');
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('"Lee"');

    const finding = findingsFromEvents(result.events)[0];
    expect(finding?.title).toBe('UI state differs from successful API state');
    expect(finding?.severity).toBe('medium');
    expect(finding?.reproduction.some((step) => step.includes('/api/profile'))).toBe(true);
  });

  it('records a match and does not emit a product finding when values agree', async () => {
    installRuntime('Lee');
    const result = await new SemanticStateAgent().run({
      url: 'https://example.test',
      visitedUrls: ['https://example.test/settings'],
      maxOperations: 10,
    });

    expect(result.summary).toMatchObject({ comparisons: 1, matches: 1, mismatches: 0 });
    expect(result.events.some((event) => event.kind === 'assertion')).toBe(false);
    expect(findingsFromEvents(result.events)).toHaveLength(0);
  });
});
