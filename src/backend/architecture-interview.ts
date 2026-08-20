import type { FrontendDiscoveryResult } from './frontend-discovery.js';

export type InterviewRoundId = 'project-understanding' | 'backend-stack' | 'data-auth' | 'security-operations' | 'mock-release';
export type QuestionKind = 'single' | 'multi' | 'text' | 'boolean';

export interface ArchitectureQuestion {
  id: string;
  round: InterviewRoundId;
  kind: QuestionKind;
  required: boolean;
  prompt: string;
  rationale: string;
  options?: string[];
  suggested?: string[];
  requiresExplicitConfirmation?: boolean;
}

export interface ArchitectureInterview {
  schemaVersion: 1;
  generatedAt: string;
  projectName: string;
  discoverySummary: {
    frameworks: string[];
    routes: number;
    forms: number;
    apiCandidates: number;
    mockSources: number;
    entities: string[];
  };
  rounds: Array<{ id: InterviewRoundId; title: string; questions: ArchitectureQuestion[] }>;
  generationBlockedUntilConfirmed: string[];
}

export interface ArchitectureAnswer {
  questionId: string;
  value: string | string[] | boolean;
  confirmed: boolean;
}

export interface InterviewValidation {
  readyForBlueprint: boolean;
  missing: string[];
  unconfirmed: string[];
  unknownQuestionIds: string[];
}

const BACKEND_OPTIONS = ['TypeScript / Node.js', 'JavaScript / Node.js', 'Python', 'Go', 'Java', 'PHP', 'C# / .NET', 'Rust', 'Other'];
const FRAMEWORK_OPTIONS = ['NestJS', 'Fastify', 'Express', 'FastAPI', 'Django', 'Gin', 'Fiber', 'Spring Boot', 'Laravel', 'ASP.NET Core', 'Axum', 'Other'];
const DATABASE_OPTIONS = ['PostgreSQL', 'MySQL/MariaDB', 'SQLite', 'MongoDB', 'DynamoDB / document NoSQL', 'Redis only', 'No database', 'Other'];
const AUTH_OPTIONS = ['Session cookie', 'JWT access/refresh tokens', 'OAuth/OIDC', 'Passkey/WebAuthn', 'API key only', 'No authentication', 'Other'];
const MOCK_OPTIONS = ['Migrate confirmed mocks to demo seed data', 'Delete mocks module-by-module after live backend verification', 'Hybrid: keep fallback mocks until each module passes QA', 'Keep mocks permanently for demo/test mode'];

function q(input: ArchitectureQuestion): ArchitectureQuestion { return input; }

export function buildArchitectureInterview(discovery: FrontendDiscoveryResult): ArchitectureInterview {
  const frameworks = discovery.frameworks.map((item) => item.name);
  const hasUploads = discovery.forms.some((form) => form.fields.some((field) => /file|image|avatar|attachment|upload/i.test(field)));
  const hasRealtimeHints = discovery.apiCandidates.some((candidate) => /socket|ws|stream|event/i.test(candidate.endpoint));
  const hasMocks = discovery.mockSources.length > 0;
  const suggestions: string[] = [];
  if (frameworks.some((value) => /React|Next|Vue|Nuxt|Angular|Svelte|Astro/i.test(value))) suggestions.push('TypeScript / Node.js');
  if (frameworks.includes('Flutter')) suggestions.push('Go', 'Python');

  const rounds: ArchitectureInterview['rounds'] = [
    {
      id: 'project-understanding', title: 'Project understanding', questions: [
        q({ id: 'project-scope-confirmation', round: 'project-understanding', kind: 'boolean', required: true, requiresExplicitConfirmation: true, prompt: 'Does the discovered frontend inventory represent the intended product scope?', rationale: 'Backend generation must not start from an incomplete or wrong frontend boundary.' }),
        q({ id: 'missing-capabilities', round: 'project-understanding', kind: 'text', required: false, prompt: 'List important product capabilities that are not visible in the current frontend.', rationale: 'Admin-only, background, billing, integration, or scheduled workflows may not be discoverable from UI code.' }),
        q({ id: 'entity-corrections', round: 'project-understanding', kind: 'text', required: false, prompt: 'Correct, merge, rename, or remove inferred entities.', rationale: `Discovery inferred ${discovery.entities.length} entity candidate(s); inference is evidence, not authority.` }),
      ],
    },
    {
      id: 'backend-stack', title: 'Backend stack', questions: [
        q({ id: 'backend-language', round: 'backend-stack', kind: 'single', required: true, requiresExplicitConfirmation: true, prompt: 'Which backend language/runtime should be used?', rationale: 'The generator must not silently choose a runtime.', options: BACKEND_OPTIONS, suggested: suggestions }),
        q({ id: 'backend-framework', round: 'backend-stack', kind: 'single', required: true, requiresExplicitConfirmation: true, prompt: 'Which backend framework should be used?', rationale: 'Framework choice controls project structure, middleware, validation, and deployment assumptions.', options: FRAMEWORK_OPTIONS }),
        q({ id: 'deployment-target', round: 'backend-stack', kind: 'text', required: true, requiresExplicitConfirmation: true, prompt: 'Where will the backend run?', rationale: 'Container, serverless, VM, PaaS, and edge environments have different security and persistence constraints.' }),
      ],
    },
    {
      id: 'data-auth', title: 'Data and authentication', questions: [
        q({ id: 'database', round: 'data-auth', kind: 'single', required: true, requiresExplicitConfirmation: true, prompt: 'Which database strategy should be used?', rationale: `The frontend suggests ${discovery.entities.length} data entity candidate(s), but persistence must be chosen explicitly.`, options: DATABASE_OPTIONS }),
        q({ id: 'authentication', round: 'data-auth', kind: 'single', required: true, requiresExplicitConfirmation: true, prompt: 'Which authentication strategy should be used?', rationale: 'Authentication affects session storage, CSRF exposure, token handling, password policy, and authorization design.', options: AUTH_OPTIONS }),
        q({ id: 'authorization-model', round: 'data-auth', kind: 'single', required: true, requiresExplicitConfirmation: true, prompt: 'Which authorization model should be enforced?', rationale: 'Generated endpoints need explicit ownership/role/permission boundaries.', options: ['RBAC roles', 'Resource ownership + roles', 'ABAC/policy engine', 'Single-user/no authorization', 'Other'] }),
        q({ id: 'data-classification', round: 'data-auth', kind: 'multi', required: true, requiresExplicitConfirmation: true, prompt: 'What sensitive data classes may be stored or processed?', rationale: 'Security controls depend on whether the system handles credentials, personal data, payment, health, education, or other regulated data.', options: ['None', 'Credentials/secrets', 'Personal data', 'Payment data', 'Health data', 'Education/student data', 'Location data', 'Files/media', 'Other'] }),
      ],
    },
    {
      id: 'security-operations', title: 'Security and operations', questions: [
        q({ id: 'security-baseline', round: 'security-operations', kind: 'multi', required: true, requiresExplicitConfirmation: true, prompt: 'Confirm the security controls that must be mandatory for generated modules.', rationale: 'Beta.8 uses deny-by-default generation gates; security controls are requirements, not post-generation polish.', options: ['Input/schema validation', 'Object-level authorization', 'Rate limiting/abuse controls', 'Secure headers/CORS', 'CSRF protection where applicable', 'Secret isolation', 'Log redaction', 'Dependency vulnerability gate', 'Audit trail', 'File validation/quarantine'] }),
        q({ id: 'external-integrations', round: 'security-operations', kind: 'text', required: false, prompt: 'List external APIs, webhooks, queues, email/SMS providers, object storage, search, or payment integrations.', rationale: 'Outbound integrations require SSRF, credential scope, webhook verification, retry, and idempotency planning.' }),
        q({ id: 'file-storage', round: 'security-operations', kind: 'single', required: hasUploads, requiresExplicitConfirmation: hasUploads, prompt: 'How should uploaded files be stored?', rationale: hasUploads ? 'File-like form fields were discovered, so storage and malware/content validation must be explicit.' : 'No confident file-upload field was discovered; choose only if the product needs uploads.', options: ['Local/private filesystem', 'S3-compatible object storage', 'Cloud provider object storage', 'No uploads', 'Other'] }),
        q({ id: 'realtime', round: 'security-operations', kind: 'single', required: hasRealtimeHints, requiresExplicitConfirmation: hasRealtimeHints, prompt: 'Does the product require realtime transport?', rationale: hasRealtimeHints ? 'Realtime-like endpoint hints were found.' : 'No strong realtime hint was found.', options: ['WebSocket', 'Server-sent events', 'Long polling', 'No realtime', 'Other'] }),
      ],
    },
    {
      id: 'mock-release', title: 'Mock migration and QA release gates', questions: [
        q({ id: 'mock-strategy', round: 'mock-release', kind: 'single', required: true, requiresExplicitConfirmation: true, prompt: 'How should existing mock data be handled as real backend modules go live?', rationale: hasMocks ? `${discovery.mockSources.length} mock/fixture source(s) were detected. Destructive cleanup requires explicit approval.` : 'Even with no detected mocks, the cleanup policy must be explicit before generated code removes or rewires frontend data sources.', options: MOCK_OPTIONS }),
        q({ id: 'seed-data-policy', round: 'mock-release', kind: 'single', required: true, requiresExplicitConfirmation: true, prompt: 'May current mock content be copied into the real database as demo/seed data?', rationale: 'Mock data can include invalid, private, copyrighted, or unrealistic values and must never be silently promoted into persistent data.', options: ['Yes, after per-record review', 'Yes, after automated validation and a review summary', 'No, create fresh seed data', 'No seed/demo data'] }),
        q({ id: 'qa-gate', round: 'mock-release', kind: 'boolean', required: true, requiresExplicitConfirmation: true, prompt: 'Require a Beta.7 QA report after every bounded backend implementation stage?', rationale: 'Stage-level verification prevents a large generation batch from hiding regressions until the end.' }),
      ],
    },
  ];

  const generationBlockedUntilConfirmed = rounds.flatMap((round) => round.questions)
    .filter((question) => question.required || question.requiresExplicitConfirmation)
    .map((question) => question.id);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectName: discovery.projectName,
    discoverySummary: {
      frameworks,
      routes: discovery.routes.length,
      forms: discovery.forms.length,
      apiCandidates: discovery.apiCandidates.length,
      mockSources: discovery.mockSources.length,
      entities: discovery.entities.map((item) => item.name).slice(0, 100),
    },
    rounds,
    generationBlockedUntilConfirmed,
  };
}

export function validateArchitectureAnswers(interview: ArchitectureInterview, answers: ArchitectureAnswer[]): InterviewValidation {
  const questions = new Map(interview.rounds.flatMap((round) => round.questions).map((question) => [question.id, question] as const));
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer] as const));
  const unknownQuestionIds = answers.filter((answer) => !questions.has(answer.questionId)).map((answer) => answer.questionId);
  const missing: string[] = [];
  const unconfirmed: string[] = [];

  for (const questionId of interview.generationBlockedUntilConfirmed) {
    const question = questions.get(questionId);
    if (!question) continue;
    const answer = answerMap.get(questionId);
    const empty = answer === undefined || answer.value === '' || Array.isArray(answer.value) && answer.value.length === 0;
    if (empty) { missing.push(questionId); continue; }
    if (question.requiresExplicitConfirmation && !answer.confirmed) unconfirmed.push(questionId);
  }

  return { readyForBlueprint: missing.length === 0 && unconfirmed.length === 0 && unknownQuestionIds.length === 0, missing, unconfirmed, unknownQuestionIds };
}
