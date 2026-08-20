import { describe, expect, it } from 'vitest';
import { buildArchitectureInterview, type ArchitectureAnswer } from '../src/backend/architecture-interview.js';
import { buildBackendBlueprint } from '../src/backend/security-blueprint.js';
import type { FrontendDiscoveryResult } from '../src/backend/frontend-discovery.js';

function discovery(): FrontendDiscoveryResult {
  return {
    schemaVersion: 1, generatedAt: '2026-08-20T00:00:00Z', projectName: 'shop-ui', filesScanned: 8, bytesScanned: 8000,
    skipped: { ignoredDirectories: 2, sensitiveFiles: 1, oversizedFiles: 0, unsupportedFiles: 3, fileLimitReached: false },
    languages: { 'TypeScript/TSX': 6, JSON: 2 },
    frameworks: [{ name: 'React', confidence: 'high', evidence: [{ path: 'src/App.tsx', confidence: 'high', detail: 'react' }] }],
    routes: [{ route: '/orders', source: 'src/App.tsx', confidence: 'high', evidence: { path: 'src/App.tsx', confidence: 'high', detail: 'route' } }],
    forms: [{ id: 'form-1', source: 'src/OrderForm.tsx', fields: ['customerId', 'note'], confidence: 'high', evidence: { path: 'src/OrderForm.tsx', confidence: 'high', detail: 'form' } }],
    apiCandidates: [
      { method: 'GET', endpoint: '/api/orders', source: 'src/api.ts', confidence: 'high', evidence: { path: 'src/api.ts', confidence: 'high', detail: 'fetch' } },
      { method: 'POST', endpoint: '/api/orders', source: 'src/api.ts', confidence: 'high', evidence: { path: 'src/api.ts', confidence: 'high', detail: 'fetch' } },
    ],
    mockSources: [{ source: 'mocks/orders.json', kind: 'mock-file', confidence: 'high', evidence: { path: 'mocks/orders.json', confidence: 'high', detail: 'mock' } }],
    state: [], entities: [{ name: 'order', confidence: 'high', sources: ['src/api.ts', 'mocks/orders.json'] }, { name: 'customer', confidence: 'medium', sources: ['src/OrderForm.tsx'] }], unresolvedQuestions: [],
  };
}

function answers(interviewReturn: ReturnType<typeof buildArchitectureInterview>): ArchitectureAnswer[] {
  const values: Record<string, string | string[] | boolean> = {
    'project-scope-confirmation': true,
    'backend-language': 'TypeScript / Node.js',
    'backend-framework': 'NestJS',
    'deployment-target': 'Docker on a private VM',
    'database': 'PostgreSQL',
    'authentication': 'Session cookie',
    'authorization-model': 'Resource ownership + roles',
    'data-classification': ['Personal data'],
    'security-baseline': ['Input/schema validation', 'Object-level authorization', 'Rate limiting/abuse controls', 'Secret isolation', 'Log redaction', 'Dependency vulnerability gate', 'Audit trail'],
    'mock-strategy': 'Hybrid: keep fallback mocks until each module passes QA',
    'seed-data-policy': 'Yes, after per-record review',
    'qa-gate': true,
  };
  return interviewReturn.generationBlockedUntilConfirmed.map((questionId) => ({ questionId, value: values[questionId] ?? 'No uploads', confirmed: true }));
}

describe('Beta.8 security-first backend blueprint', () => {
  it('refuses to produce a blueprint from unconfirmed architecture decisions', () => {
    const source = discovery(); const interview = buildArchitectureInterview(source);
    expect(() => buildBackendBlueprint({ discovery: source, interview, answers: [] })).toThrow(/not ready/);
  });

  it('creates a deny-by-default bounded plan without granting mutation or destructive mock cleanup permission', () => {
    const source = discovery(); const interview = buildArchitectureInterview(source);
    const blueprint = buildBackendBlueprint({ discovery: source, interview, answers: answers(interview) });
    expect(blueprint.security.denyByDefault).toBe(true);
    expect(blueprint.security.controls.map((control) => control.id)).toEqual(expect.arrayContaining(['schema-validation', 'deny-by-default-authorization', 'parameterized-data-access', 'secret-isolation']));
    expect(blueprint.apiPlan.some((endpoint) => endpoint.method === 'POST' && endpoint.idempotencyRequired)).toBe(true);
    expect(blueprint.tasks.every((task) => task.mutationAllowed === false && task.requiresApprovalBeforeExecution)).toBe(true);
    expect(blueprint.tasks.at(-1)?.id).toBe('B8-QA-001');
    expect(blueprint.mockMigration[0]).toMatchObject({ proposedAction: 'retain-until-module-qa', destructive: false, requiresUserApproval: true });
    expect(blueprint.executionGate.approved).toBe(false);
  });
});
