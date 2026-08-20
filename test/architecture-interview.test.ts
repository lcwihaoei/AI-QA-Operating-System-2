import { describe, expect, it } from 'vitest';
import { buildArchitectureInterview, validateArchitectureAnswers, type ArchitectureAnswer } from '../src/backend/architecture-interview.js';
import type { FrontendDiscoveryResult } from '../src/backend/frontend-discovery.js';

function discovery(): FrontendDiscoveryResult {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-20T00:00:00.000Z',
    projectName: 'fixture',
    filesScanned: 4,
    bytesScanned: 2000,
    skipped: { ignoredDirectories: 1, sensitiveFiles: 1, oversizedFiles: 0, unsupportedFiles: 2, fileLimitReached: false },
    languages: { 'TypeScript/TSX': 2, JSON: 2 },
    frameworks: [{ name: 'React', confidence: 'high', evidence: [{ path: 'src/App.tsx', confidence: 'high', detail: 'React import' }] }],
    routes: [{ route: '/users', source: 'src/App.tsx', confidence: 'high', evidence: { path: 'src/App.tsx', confidence: 'high', detail: 'route' } }],
    forms: [{ id: 'form-1', source: 'src/App.tsx', fields: ['email'], confidence: 'high', evidence: { path: 'src/App.tsx', confidence: 'high', detail: 'form' } }],
    apiCandidates: [{ method: 'GET', endpoint: '/api/users', source: 'src/App.tsx', confidence: 'high', evidence: { path: 'src/App.tsx', confidence: 'high', detail: 'fetch' } }],
    mockSources: [{ source: 'mocks/users.json', kind: 'mock-file', confidence: 'high', evidence: { path: 'mocks/users.json', confidence: 'high', detail: 'mock' } }],
    state: [],
    entities: [{ name: 'user', confidence: 'high', sources: ['src/App.tsx', 'mocks/users.json'] }],
    unresolvedQuestions: [],
  };
}

function answer(questionId: string, value: string | string[] | boolean, confirmed = true): ArchitectureAnswer { return { questionId, value, confirmed }; }

describe('Beta.8 architecture interview', () => {
  it('requires multiple explicit confirmation rounds and never treats suggestions as user decisions', () => {
    const interview = buildArchitectureInterview(discovery());
    expect(interview.rounds.map((round) => round.id)).toEqual(['project-understanding', 'backend-stack', 'data-auth', 'security-operations', 'mock-release']);
    expect(interview.generationBlockedUntilConfirmed).toContain('backend-language');
    expect(interview.generationBlockedUntilConfirmed).toContain('database');
    expect(interview.generationBlockedUntilConfirmed).toContain('mock-strategy');
    expect(validateArchitectureAnswers(interview, []).readyForBlueprint).toBe(false);
  });

  it('blocks blueprint generation when a mandatory answer exists but is not explicitly confirmed', () => {
    const interview = buildArchitectureInterview(discovery());
    const values: Record<string, string | string[] | boolean> = { 'project-scope-confirmation': true, 'backend-language': 'TypeScript / Node.js', 'backend-framework': 'NestJS', 'deployment-target': 'Docker', database: 'PostgreSQL', authentication: 'Session cookie', 'authorization-model': 'RBAC roles', 'data-classification': ['None'], 'security-baseline': ['Input/schema validation'], 'mock-strategy': 'Hybrid: keep fallback mocks until each module passes QA', 'seed-data-policy': 'No, create fresh seed data', 'qa-gate': true };
    const answers = interview.generationBlockedUntilConfirmed.map((id) => answer(id, values[id] ?? 'No uploads'));
    const backend = answers.find((item) => item.questionId === 'backend-language')!;
    backend.confirmed = false;
    const validation = validateArchitectureAnswers(interview, answers);
    expect(validation.readyForBlueprint).toBe(false);
    expect(validation.unconfirmed).toContain('backend-language');
  });

  it('becomes blueprint-ready only after every generation gate has an explicit answer and confirmation', () => {
    const interview = buildArchitectureInterview(discovery());
    const values: Record<string, string | string[] | boolean> = { 'project-scope-confirmation': true, 'backend-language': 'TypeScript / Node.js', 'backend-framework': 'NestJS', 'deployment-target': 'Docker', database: 'PostgreSQL', authentication: 'Session cookie', 'authorization-model': 'RBAC roles', 'data-classification': ['Personal data'], 'security-baseline': ['Input/schema validation', 'Object-level authorization', 'Secret isolation'], 'mock-strategy': 'Hybrid: keep fallback mocks until each module passes QA', 'seed-data-policy': 'No, create fresh seed data', 'qa-gate': true };
    const answers = interview.generationBlockedUntilConfirmed.map((id) => answer(id, values[id] ?? 'No uploads'));
    const validation = validateArchitectureAnswers(interview, answers);
    expect(validation).toEqual({ readyForBlueprint: true, missing: [], unconfirmed: [], invalid: [], unknownQuestionIds: [], duplicateQuestionIds: [] });
  });
});
