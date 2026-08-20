import { validateArchitectureAnswers, type ArchitectureAnswer, type ArchitectureInterview } from './architecture-interview.js';
import type { ApiCandidate, EntityCandidate, FrontendDiscoveryResult, MockSourceFinding } from './frontend-discovery.js';

export interface SecurityControl {
  id: string;
  requirement: string;
  verification: string;
  mandatory: true;
  source: 'beta8-minimum' | 'user-confirmed';
}

export interface ThreatSurfaceItem {
  id: string;
  area: string;
  reason: string;
  requiredControls: string[];
}

export interface PlannedEndpoint {
  method: string;
  path: string;
  module: string;
  evidenceSources: string[];
  authRequired: boolean;
  validationRequired: true;
  idempotencyRequired: boolean;
}

export interface PlannedEntity {
  name: string;
  evidenceSources: string[];
  fields: Array<{ name: string; source: string; inferred: true }>;
  requiresSchemaConfirmation: true;
}

export interface BackendImplementationTask {
  id: string;
  phase: 'foundation' | 'data-auth' | 'module' | 'frontend-integration' | 'qa';
  module: string;
  title: string;
  scope: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  mutationAllowed: false;
  requiresApprovalBeforeExecution: true;
}

export interface MockMigrationItem {
  source: string;
  kind: MockSourceFinding['kind'];
  proposedAction: 'review-for-seed' | 'remove-after-live-qa' | 'retain-until-module-qa' | 'retain-permanently';
  destructive: boolean;
  requiresUserApproval: true;
}

export interface BackendBlueprint {
  schemaVersion: 1;
  generatedAt: string;
  projectName: string;
  architecture: {
    backendLanguage: string;
    backendFramework: string;
    deploymentTarget: string;
    database: string;
    authentication: string;
    authorizationModel: string;
    dataClassification: string[];
    mockStrategy: string;
    seedDataPolicy: string;
    beta7AfterEveryStage: boolean;
  };
  discovery: {
    filesScanned: number;
    frameworks: string[];
    routes: number;
    forms: number;
    apiCandidates: number;
    mockSources: number;
  };
  security: {
    denyByDefault: true;
    controls: SecurityControl[];
    threatSurface: ThreatSurfaceItem[];
  };
  dataModel: PlannedEntity[];
  apiPlan: PlannedEndpoint[];
  tasks: BackendImplementationTask[];
  mockMigration: MockMigrationItem[];
  executionGate: {
    approved: false;
    reason: string;
  };
}

const MINIMUM_SECURITY_CONTROLS: SecurityControl[] = [
  { id: 'schema-validation', requirement: 'Validate every untrusted request at the transport boundary with an allow-list schema.', verification: 'Negative tests reject unknown, malformed, oversized, and type-confused inputs.', mandatory: true, source: 'beta8-minimum' },
  { id: 'deny-by-default-authorization', requirement: 'Every non-public resource operation must enforce explicit object/action authorization.', verification: 'Cross-user and lower-role access regression tests must fail closed.', mandatory: true, source: 'beta8-minimum' },
  { id: 'parameterized-data-access', requirement: 'Database access must use parameterized/ORM query APIs; user input may not alter query structure.', verification: 'Injection payload regression suite and static review of raw query escape hatches.', mandatory: true, source: 'beta8-minimum' },
  { id: 'rate-abuse-controls', requirement: 'Authentication and write-heavy endpoints require bounded abuse/rate controls.', verification: 'Burst tests verify throttling without leaking account existence.', mandatory: true, source: 'beta8-minimum' },
  { id: 'secret-isolation', requirement: 'Secrets must come from runtime secret/config channels and never be generated into source or logs.', verification: 'Repository secret scan and log redaction regression.', mandatory: true, source: 'beta8-minimum' },
  { id: 'safe-errors-logs', requirement: 'Client errors must be bounded; logs must redact credentials, tokens and sensitive values.', verification: 'Error-path tests confirm no stack/secret/value leakage.', mandatory: true, source: 'beta8-minimum' },
  { id: 'browser-boundary', requirement: 'CORS, cookies, CSRF and secure headers must be explicit for the selected authentication/browser topology.', verification: 'Origin/credential/CSRF negative tests plus header assertions.', mandatory: true, source: 'beta8-minimum' },
  { id: 'dependency-supply-chain', requirement: 'Generated dependencies must pass vulnerability and lockfile/integrity gates before merge.', verification: 'CI dependency vulnerability gate and deterministic lockfile review.', mandatory: true, source: 'beta8-minimum' },
  { id: 'audit-security-events', requirement: 'Security-relevant authentication, authorization, destructive and administrative events require bounded audit records.', verification: 'Audit tests assert event presence without storing secrets or raw sensitive payloads.', mandatory: true, source: 'beta8-minimum' },
];

function answerMap(answers: ArchitectureAnswer[]): Map<string, ArchitectureAnswer> {
  return new Map(answers.map((answer) => [answer.questionId, answer]));
}

function stringValue(map: Map<string, ArchitectureAnswer>, id: string): string {
  const value = map.get(id)?.value;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing string architecture answer: ${id}`);
  return value.trim();
}

function stringArrayValue(map: Map<string, ArchitectureAnswer>, id: string): string[] {
  const value = map.get(id)?.value;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`missing list architecture answer: ${id}`);
  return [...new Set(value.map((item) => item.trim()))];
}

function booleanValue(map: Map<string, ArchitectureAnswer>, id: string): boolean {
  const value = map.get(id)?.value;
  if (typeof value !== 'boolean') throw new Error(`missing boolean architecture answer: ${id}`);
  return value;
}

function moduleForEndpoint(endpoint: string): string {
  const pathname = endpoint.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0] ?? '';
  const parts = pathname.split('/').filter(Boolean).filter((part) => !/^api$|^v\d+$/i.test(part));
  const first = parts.find((part) => !part.startsWith(':') && !/^\d+$/.test(part));
  return (first ?? 'core').replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase().slice(0, 80) || 'core';
}

function planEndpoints(candidates: ApiCandidate[], authStrategy: string): PlannedEndpoint[] {
  const grouped = new Map<string, PlannedEndpoint>();
  for (const candidate of candidates) {
    const key = `${candidate.method.toUpperCase()}\u0000${candidate.endpoint}`;
    const current = grouped.get(key);
    if (current) {
      if (!current.evidenceSources.includes(candidate.source) && current.evidenceSources.length < 20) current.evidenceSources.push(candidate.source);
      continue;
    }
    const method = candidate.method.toUpperCase();
    grouped.set(key, {
      method,
      path: candidate.endpoint,
      module: moduleForEndpoint(candidate.endpoint),
      evidenceSources: [candidate.source],
      authRequired: authStrategy !== 'No authentication',
      validationRequired: true,
      idempotencyRequired: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method),
    });
  }
  return [...grouped.values()].sort((a, b) => a.module.localeCompare(b.module) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method)).slice(0, 2_000);
}

function fieldsForEntity(entity: EntityCandidate, discovery: FrontendDiscoveryResult) {
  const fields = new Map<string, string>();
  for (const form of discovery.forms) {
    const related = entity.sources.includes(form.source) || form.fields.some((field) => field.toLowerCase().includes(entity.name.toLowerCase()));
    if (!related) continue;
    for (const field of form.fields) if (field && !fields.has(field)) fields.set(field, form.source);
  }
  return [...fields.entries()].slice(0, 100).map(([name, source]) => ({ name, source, inferred: true as const }));
}

function planEntities(discovery: FrontendDiscoveryResult): PlannedEntity[] {
  return discovery.entities.slice(0, 500).map((entity) => ({
    name: entity.name,
    evidenceSources: entity.sources,
    fields: fieldsForEntity(entity, discovery),
    requiresSchemaConfirmation: true,
  }));
}

function planThreatSurface(discovery: FrontendDiscoveryResult, endpoints: PlannedEndpoint[], answers: Map<string, ArchitectureAnswer>): ThreatSurfaceItem[] {
  const items: ThreatSurfaceItem[] = [];
  if (endpoints.some((endpoint) => endpoint.authRequired)) items.push({ id: 'authz', area: 'Authenticated resource access', reason: 'Generated endpoints will process authenticated requests.', requiredControls: ['deny-by-default-authorization', 'safe-errors-logs', 'audit-security-events'] });
  if (endpoints.some((endpoint) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method))) items.push({ id: 'mutation', area: 'State-changing APIs', reason: 'Write endpoints can be abused, replayed, CSRF-triggered, or used for mass assignment.', requiredControls: ['schema-validation', 'deny-by-default-authorization', 'rate-abuse-controls', 'browser-boundary'] });
  if (discovery.mockSources.length > 0) items.push({ id: 'mock-migration', area: 'Mock/demo data promotion', reason: 'Existing mock values may be unsafe or semantically invalid as persistent data.', requiredControls: ['schema-validation', 'safe-errors-logs'] });
  const integrationText = answers.get('external-integrations')?.value;
  if (typeof integrationText === 'string' && integrationText.trim()) items.push({ id: 'outbound', area: 'External integrations', reason: 'Outbound requests/webhooks introduce SSRF, credential scope, replay and retry risks.', requiredControls: ['secret-isolation', 'safe-errors-logs', 'rate-abuse-controls'] });
  const classifications = answers.get('data-classification')?.value;
  if (Array.isArray(classifications) && !classifications.includes('None')) items.push({ id: 'sensitive-data', area: 'Sensitive data handling', reason: `Confirmed data classes: ${classifications.join(', ')}.`, requiredControls: ['secret-isolation', 'safe-errors-logs', 'audit-security-events', 'deny-by-default-authorization'] });
  return items;
}

function mockAction(strategy: string): MockMigrationItem['proposedAction'] {
  if (strategy.startsWith('Migrate confirmed mocks')) return 'review-for-seed';
  if (strategy.startsWith('Delete mocks')) return 'remove-after-live-qa';
  if (strategy.startsWith('Hybrid')) return 'retain-until-module-qa';
  return 'retain-permanently';
}

function planMockMigration(mocks: MockSourceFinding[], strategy: string): MockMigrationItem[] {
  const proposedAction = mockAction(strategy);
  return mocks.map((mock) => ({
    source: mock.source,
    kind: mock.kind,
    proposedAction,
    destructive: proposedAction === 'remove-after-live-qa',
    requiresUserApproval: true,
  }));
}

function planTasks(entities: PlannedEntity[], endpoints: PlannedEndpoint[], mocks: MockMigrationItem[]): BackendImplementationTask[] {
  const tasks: BackendImplementationTask[] = [];
  const push = (task: BackendImplementationTask) => tasks.push(task);
  push({ id: 'B8-FND-001', phase: 'foundation', module: 'platform', title: 'Create backend project safety foundation', scope: ['framework bootstrap', 'configuration boundary', 'safe error envelope', 'request validation', 'security middleware'], dependsOn: [], acceptanceCriteria: ['build/typecheck passes', 'no secrets in tracked source', 'negative input tests fail closed', 'security headers/CORS policy is explicit'], mutationAllowed: false, requiresApprovalBeforeExecution: true });
  push({ id: 'B8-DATA-001', phase: 'data-auth', module: 'persistence', title: 'Create persistence and migration foundation', scope: ['database connection', 'migration runner', 'transaction boundaries'], dependsOn: ['B8-FND-001'], acceptanceCriteria: ['migrations are reversible or have documented rollback', 'queries are parameterized', 'test database can be recreated from zero'], mutationAllowed: false, requiresApprovalBeforeExecution: true });
  push({ id: 'B8-AUTH-001', phase: 'data-auth', module: 'auth', title: 'Implement authentication and authorization boundary', scope: ['authentication strategy', 'authorization policy', 'security event audit'], dependsOn: ['B8-FND-001', 'B8-DATA-001'], acceptanceCriteria: ['unauthenticated and cross-user negative tests pass', 'credentials/tokens are redacted', 'privileged actions are audited'], mutationAllowed: false, requiresApprovalBeforeExecution: true });

  const modules = [...new Set([...entities.map((entity) => entity.name), ...endpoints.map((endpoint) => endpoint.module)])].filter(Boolean).sort().slice(0, 300);
  for (const [index, module] of modules.entries()) {
    const id = `B8-MOD-${String(index + 1).padStart(3, '0')}`;
    const moduleEndpoints = endpoints.filter((endpoint) => endpoint.module === module);
    const entity = entities.find((candidate) => candidate.name === module || candidate.name.replace(/s$/i, '') === module.replace(/s$/i, ''));
    push({ id, phase: 'module', module, title: `Implement ${module} backend slice`, scope: [...(entity ? [`entity:${entity.name}`] : []), ...moduleEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).slice(0, 80)], dependsOn: ['B8-DATA-001', 'B8-AUTH-001'], acceptanceCriteria: ['schema and authorization tests pass', 'API contract is traced to frontend evidence', 'no mock source is deleted before live integration QA'], mutationAllowed: false, requiresApprovalBeforeExecution: true });
  }

  push({ id: 'B8-INT-001', phase: 'frontend-integration', module: 'frontend', title: 'Rewire confirmed frontend modules to live backend', scope: ['API client wiring', 'error/loading states', 'environment configuration', 'approved mock transition only'], dependsOn: tasks.filter((task) => task.phase === 'module').map((task) => task.id), acceptanceCriteria: ['frontend no longer depends on replaced mocks', 'fallback behavior matches approved mock strategy', 'native frontend verification passes'], mutationAllowed: false, requiresApprovalBeforeExecution: true });
  if (mocks.length > 0) push({ id: 'B8-MOCK-001', phase: 'frontend-integration', module: 'mock-migration', title: 'Apply approved mock migration/cleanup plan', scope: mocks.map((item) => `${item.proposedAction}:${item.source}`).slice(0, 200), dependsOn: ['B8-INT-001'], acceptanceCriteria: ['each destructive item has explicit user approval', 'seed data is validated before persistence', 'removed mocks have no remaining runtime references'], mutationAllowed: false, requiresApprovalBeforeExecution: true });
  push({ id: 'B8-QA-001', phase: 'qa', module: 'beta7', title: 'Run Beta.7 evidence-rich QA gate', scope: ['functional QA', 'visual QA', 'responsive QA', 'evidence report', 'regression classification'], dependsOn: [mocks.length > 0 ? 'B8-MOCK-001' : 'B8-INT-001'], acceptanceCriteria: ['Beta.7 report generated', 'no unresolved critical/high regression accepted silently', 'findings are available for Beta.9 selection'], mutationAllowed: false, requiresApprovalBeforeExecution: true });
  return tasks;
}

export function buildBackendBlueprint(input: { discovery: FrontendDiscoveryResult; interview: ArchitectureInterview; answers: ArchitectureAnswer[] }): BackendBlueprint {
  const validation = validateArchitectureAnswers(input.interview, input.answers);
  if (!validation.readyForBlueprint) throw new Error(`architecture interview is not ready for blueprint generation: missing=${validation.missing.join(',')} unconfirmed=${validation.unconfirmed.join(',')} invalid=${validation.invalid.join(',')}`);
  const answers = answerMap(input.answers);
  const architecture = {
    backendLanguage: stringValue(answers, 'backend-language'),
    backendFramework: stringValue(answers, 'backend-framework'),
    deploymentTarget: stringValue(answers, 'deployment-target'),
    database: stringValue(answers, 'database'),
    authentication: stringValue(answers, 'authentication'),
    authorizationModel: stringValue(answers, 'authorization-model'),
    dataClassification: stringArrayValue(answers, 'data-classification'),
    mockStrategy: stringValue(answers, 'mock-strategy'),
    seedDataPolicy: stringValue(answers, 'seed-data-policy'),
    beta7AfterEveryStage: booleanValue(answers, 'qa-gate'),
  };
  const userSecurity = stringArrayValue(answers, 'security-baseline').map((requirement, index): SecurityControl => ({ id: `user-security-${String(index + 1).padStart(2, '0')}`, requirement, verification: 'Must have an explicit automated or review gate before the related task can complete.', mandatory: true, source: 'user-confirmed' }));
  const controls = [...MINIMUM_SECURITY_CONTROLS, ...userSecurity.filter((item) => !MINIMUM_SECURITY_CONTROLS.some((minimum) => minimum.requirement === item.requirement))];
  const apiPlan = planEndpoints(input.discovery.apiCandidates, architecture.authentication);
  const dataModel = planEntities(input.discovery);
  const mockMigration = planMockMigration(input.discovery.mockSources, architecture.mockStrategy);
  const tasks = planTasks(dataModel, apiPlan, mockMigration);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectName: input.discovery.projectName,
    architecture,
    discovery: { filesScanned: input.discovery.filesScanned, frameworks: input.discovery.frameworks.map((item) => item.name), routes: input.discovery.routes.length, forms: input.discovery.forms.length, apiCandidates: input.discovery.apiCandidates.length, mockSources: input.discovery.mockSources.length },
    security: { denyByDefault: true, controls, threatSurface: planThreatSurface(input.discovery, apiPlan, answers) },
    dataModel,
    apiPlan,
    tasks,
    mockMigration,
    executionGate: { approved: false, reason: 'Blueprint generation never grants source-mutation permission. A later bounded execution stage requires separate explicit approval.' },
  };
}
