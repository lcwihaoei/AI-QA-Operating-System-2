import type { WorkItem, WorkPlan } from './work-item.js';

export type ProductOpportunitySource = 'user-request' | 'ux-opportunity' | 'qa-finding' | 'frontend-discovery' | 'product-review';

export interface ProductOpportunity {
  id: string;
  source: ProductOpportunitySource;
  title: string;
  observation: string;
  userValue: string;
  expectedImpact: 'high' | 'medium' | 'low';
  estimatedEffort: 'high' | 'medium' | 'low';
  confidence: number;
  evidence: string[];
  affectedAreas: string[];
  designSystemConstraints: string[];
}

export interface FeatureAlternative {
  id: string;
  title: string;
  summary: string;
  advantages: string[];
  tradeoffs: string[];
  implementationCost: 'high' | 'medium' | 'low';
  securityConsiderations: string[];
}

export interface ProductArchitectureReview {
  recommendedAlternativeId: 'minimal' | 'balanced' | 'platform';
  recommendationReason: string;
  architectureSignals: string[];
  challenges: string[];
  omittedConstraintPrompts: string[];
  requiresExplicitSelection: true;
}

export interface FeaturePlanningQuestion {
  id: string;
  prompt: string;
  reason: string;
  required: boolean;
  kind: 'text' | 'single' | 'multi' | 'boolean';
  options?: string[];
}

export interface FeaturePlanningAnswer {
  questionId: string;
  value: string | string[] | boolean;
  confirmed: boolean;
}

export interface FeaturePlanningSession {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  opportunity: ProductOpportunity;
  currentProductUnderstanding: string[];
  architectureReview?: ProductArchitectureReview;
  questions: FeaturePlanningQuestion[];
  alternatives: FeatureAlternative[];
  selectedAlternativeId?: string;
  generationBlockedUntil: string[];
}

export interface FeatureBlueprint {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  opportunityId: string;
  selectedAlternative: FeatureAlternative;
  architectureReview?: ProductArchitectureReview;
  userFlow: string[];
  informationArchitecture: string[];
  frontendRequirements: string[];
  backendRequirements: string[];
  dataRequirements: string[];
  securityRequirements: string[];
  accessibilityRequirements: string[];
  responsiveRequirements: string[];
  emptyLoadingErrorStates: string[];
  analyticsRequirements: string[];
  acceptanceCriteria: string[];
  workPlan: WorkPlan;
}

function validConfidence(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }

function architectureReview(
  opportunity: ProductOpportunity,
  currentProductUnderstanding: string[],
): ProductArchitectureReview {
  const signals = [...new Set(currentProductUnderstanding.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
  const corpus = `${signals.join(' ')} ${opportunity.affectedAreas.join(' ')}`.toLowerCase();
  const platformSignal = /platform|shared|reusable|common|domain|multi[- ]?(tenant|module)|cross[- ]?(module|product)/.test(corpus);
  const recommendedAlternativeId: ProductArchitectureReview['recommendedAlternativeId'] = platformSignal && opportunity.estimatedEffort !== 'low'
    ? 'platform'
    : opportunity.estimatedEffort === 'low'
      ? 'minimal'
      : 'balanced';

  const recommendationReason = recommendedAlternativeId === 'platform'
    ? 'Existing architecture signals suggest this capability may have multiple consumers; review a reusable domain boundary before duplicating feature-specific infrastructure.'
    : recommendedAlternativeId === 'minimal'
      ? 'The requested outcome appears suitable for a small integrated slice; prefer proving user value before creating a broader platform abstraction.'
      : 'The request has meaningful product impact without clear evidence that a platform abstraction is already justified; prefer a complete primary flow with bounded extension points.';

  const challenges = [
    'Reuse or extend an existing domain/service/state owner before creating a parallel subsystem with overlapping responsibility.',
    'Do not introduce a new table, store, service or API merely because the requested solution names one; first verify that the current model cannot represent the outcome safely.',
    'Treat mobile/responsive, keyboard/accessibility, empty/loading/error, permissions and rollback behavior as part of the feature contract rather than post-implementation QA details.',
    ...(signals.length > 0 ? [`Cross-check the requested design against existing product signals: ${signals.slice(0, 5).join(' · ')}`] : []),
  ];

  return {
    recommendedAlternativeId,
    recommendationReason,
    architectureSignals: signals,
    challenges,
    omittedConstraintPrompts: [
      'Which existing capability already owns the same data, state or workflow responsibility?',
      'What changes for mobile/responsive and keyboard/assistive-technology users?',
      'What is the failure, cancellation and rollback behavior?',
      'Does the feature require new persistence/migration, or can the existing domain model represent it?',
      'Which permissions, roles or tenant boundaries must remain true?',
    ],
    requiresExplicitSelection: true,
  };
}

export function buildFeaturePlanningSession(input: {
  project: string;
  opportunity: ProductOpportunity;
  currentProductUnderstanding: string[];
}): FeaturePlanningSession {
  if (!input.project.trim()) throw new Error('project is required');
  if (!input.opportunity.id.trim() || !input.opportunity.title.trim()) throw new Error('opportunity id/title is required');
  if (!validConfidence(input.opportunity.confidence)) throw new Error('opportunity confidence must be between 0 and 1');
  if (input.opportunity.evidence.length === 0) throw new Error('feature planning requires at least one evidence reference');

  const review = architectureReview(input.opportunity, input.currentProductUnderstanding);
  const questions: FeaturePlanningQuestion[] = [
    { id: 'feature-goal-confirmation', prompt: 'Confirm the user outcome this feature must improve.', reason: 'Prevents implementation from optimizing an inferred goal that the user did not request.', required: true, kind: 'text' },
    { id: 'target-users', prompt: 'Who should be able to use this feature?', reason: 'Defines product scope, permissions and QA personas.', required: true, kind: 'multi', options: ['All users', 'Authenticated users', 'Admin/owner only', 'Role-based subset', 'Other'] },
    { id: 'must-preserve-existing-flow', prompt: 'Must the current workflow remain available during rollout?', reason: 'Controls migration, feature flags and backward compatibility.', required: true, kind: 'boolean' },
    { id: 'design-system-boundary', prompt: 'Confirm that new UI must reuse the current product design system unless an explicit redesign is approved.', reason: 'Prevents a generated feature from inventing an unrelated visual language.', required: true, kind: 'boolean' },
    { id: 'data-sensitivity', prompt: 'What data classification will the new feature process?', reason: 'Determines storage, logging, authorization and retention requirements.', required: true, kind: 'multi', options: ['Public', 'Internal', 'Personal data', 'Sensitive personal data', 'Credentials/tokens', 'Payment/financial', 'None', 'Other'] },
    { id: 'release-strategy', prompt: 'Choose a release strategy.', reason: 'Controls risk and how Beta.7 validates the feature.', required: true, kind: 'single', options: ['Feature flag / staged rollout', 'Owner-only preview', 'All users after QA', 'Other'] },
    { id: 'existing-capability-reuse', prompt: 'Has the team explicitly checked whether an existing domain/service/state owner can satisfy this outcome before adding a parallel subsystem?', reason: 'Prevents duplicated architecture and keeps the new feature inside the existing system ownership model.', required: true, kind: 'boolean' },
    { id: 'cross-surface-impact', prompt: 'Which additional product surfaces must the design explicitly cover?', reason: 'Surfaces omitted requirements before implementation rather than discovering them as QA regressions.', required: true, kind: 'multi', options: ['Desktop', 'Mobile/responsive', 'Keyboard/assistive technology', 'API/backend', 'Data migration', 'No additional surface', 'Other'] },
    { id: 'failure-rollback-contract', prompt: 'Describe expected cancellation, failure and rollback behavior for the primary workflow.', reason: 'A happy-path-only blueprint is not sufficient for implementation or QA.', required: true, kind: 'text' },
  ];

  const alternatives: FeatureAlternative[] = [
    {
      id: 'minimal', title: 'Minimal integrated slice', summary: 'Deliver the smallest end-to-end version that fits the existing architecture and design system.',
      advantages: ['Lowest change surface', 'Fastest route to real-user validation', 'Simpler rollback'], tradeoffs: ['May defer advanced workflows'], implementationCost: 'low',
      securityConsiderations: ['Reuse existing authentication/authorization boundaries', 'Keep new data surface minimal'],
    },
    {
      id: 'balanced', title: 'Balanced product feature', summary: 'Deliver the complete primary workflow plus expected management, responsive and error states.',
      advantages: ['Good product completeness', 'Enough surface for meaningful Beta.7 QA'], tradeoffs: ['Moderate implementation and migration cost'], implementationCost: 'medium',
      securityConsiderations: ['Threat-model new write paths', 'Add role/object authorization tests where applicable'],
    },
    {
      id: 'platform', title: 'Platform-level capability', summary: 'Design the feature as a reusable domain/platform capability for future modules.',
      advantages: ['Reusable architecture', 'Lower future duplication'], tradeoffs: ['Highest up-front complexity', 'Greater regression surface'], implementationCost: 'high',
      securityConsiderations: ['Explicit tenancy/role boundaries', 'Versioned contracts and stronger migration controls'],
    },
  ];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: input.project.trim(),
    opportunity: input.opportunity,
    currentProductUnderstanding: [...new Set(input.currentProductUnderstanding.map((value) => value.trim()).filter(Boolean))].slice(0, 500),
    architectureReview: review,
    questions,
    alternatives,
    generationBlockedUntil: questions.filter((question) => question.required).map((question) => question.id),
  };
}

export function validateFeaturePlanningAnswers(session: FeaturePlanningSession, answers: FeaturePlanningAnswer[]): { ready: boolean; missing: string[]; invalid: string[]; unconfirmed: string[] } {
  const questions = new Map(session.questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  const invalid: string[] = [];
  const unconfirmed: string[] = [];

  for (const answer of answers) {
    if (seen.has(answer.questionId) || !questions.has(answer.questionId)) { invalid.push(answer.questionId); continue; }
    seen.add(answer.questionId);
    const question = questions.get(answer.questionId)!;
    const value = answer.value;
    const typeValid = question.kind === 'boolean' ? typeof value === 'boolean'
      : question.kind === 'multi' ? Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim())
        : typeof value === 'string' && value.trim().length > 0;
    if (!typeValid) invalid.push(answer.questionId);
    if (answer.confirmed !== true) unconfirmed.push(answer.questionId);
    if (question.options && question.kind === 'single' && typeof value === 'string' && !question.options.includes(value)) invalid.push(answer.questionId);
    if (question.options && question.kind === 'multi' && Array.isArray(value) && value.some((item) => typeof item !== 'string' || !question.options!.includes(item))) invalid.push(answer.questionId);
  }

  const missing = session.questions.filter((question) => question.required && !seen.has(question.id)).map((question) => question.id);
  return { ready: missing.length === 0 && invalid.length === 0 && unconfirmed.length === 0, missing, invalid: [...new Set(invalid)], unconfirmed: [...new Set(unconfirmed)] };
}

function baseWorkItem(input: Pick<WorkItem, 'id' | 'kind' | 'title' | 'goal' | 'why' | 'dependencies' | 'affectedModules' | 'designRequirements' | 'implementationPlan' | 'securityImpact' | 'acceptanceCriteria' | 'requiredTests'>, opportunity: ProductOpportunity): WorkItem {
  return {
    ...input,
    source: opportunity.evidence.map((reference) => ({ type: opportunity.source === 'user-request' ? 'user-request' : opportunity.source === 'qa-finding' ? 'qa-finding' : opportunity.source === 'ux-opportunity' ? 'ux-opportunity' : opportunity.source === 'frontend-discovery' ? 'frontend-discovery' : 'source', reference })),
    status: 'planned', priority: opportunity.expectedImpact === 'high' ? 'P1' : opportunity.expectedImpact === 'medium' ? 'P2' : 'P3', confidence: opportunity.confidence,
    affectedFiles: [], risks: [], qaStrategy: ['Run targeted tests for this task.', 'Run Beta.7 evidence-rich QA before accepting the feature.'],
    approval: { required: true, approved: false },
    execution: { mutationAllowed: false, allowedPaths: [], forbiddenPaths: ['.git/**', '.github/workflows/**', '**/.env*', '**/*secret*', '**/*credential*', '**/*.pem', '**/*.key'], maxAttempts: 3, requireCleanWorkspace: true, requireIsolatedBranch: true, requireTargetedTests: true, requireRegressionTests: true, requireBeta7Qa: true },
  };
}

export function buildFeatureBlueprint(input: {
  session: FeaturePlanningSession;
  answers: FeaturePlanningAnswer[];
  selectedAlternativeId: string;
  userFlow: string[];
  informationArchitecture: string[];
  frontendRequirements: string[];
  backendRequirements: string[];
  dataRequirements: string[];
  securityRequirements: string[];
}): FeatureBlueprint {
  const validation = validateFeaturePlanningAnswers(input.session, input.answers);
  if (!validation.ready) throw new Error(`feature planning is not confirmed: ${JSON.stringify(validation)}`);
  const selectedAlternative = input.session.alternatives.find((alternative) => alternative.id === input.selectedAlternativeId);
  if (!selectedAlternative) throw new Error('selected feature alternative does not exist');
  const opportunity = input.session.opportunity;

  const tasks: WorkItem[] = [
    baseWorkItem({ id: `FEAT-${opportunity.id}-DESIGN`, kind: 'feature', title: `Finalize ${opportunity.title} product contract`, goal: 'Freeze the approved user flow, states, permissions and acceptance contract before code changes.', why: opportunity.userValue, dependencies: [], affectedModules: opportunity.affectedAreas, designRequirements: [...opportunity.designSystemConstraints, ...input.userFlow, ...input.informationArchitecture], implementationPlan: ['Confirm feature contract', 'Record selected alternative', 'Lock acceptance criteria'], securityImpact: input.securityRequirements, acceptanceCriteria: ['User flow and permissions are explicitly confirmed', 'No unresolved planning question remains'], requiredTests: ['Planning contract validation'] }, opportunity),
    baseWorkItem({ id: `FEAT-${opportunity.id}-FRONTEND`, kind: 'frontend', title: `Implement ${opportunity.title} frontend`, goal: 'Implement the approved UI and interaction states using the existing design system.', why: opportunity.userValue, dependencies: [`FEAT-${opportunity.id}-DESIGN`], affectedModules: opportunity.affectedAreas, designRequirements: [...opportunity.designSystemConstraints, ...input.frontendRequirements], implementationPlan: input.frontendRequirements, securityImpact: input.securityRequirements, acceptanceCriteria: ['Responsive states match the approved design contract', 'Loading, empty, error and permission states are handled'], requiredTests: ['Component/interaction tests', 'Responsive browser verification', 'Accessibility checks'] }, opportunity),
    baseWorkItem({ id: `FEAT-${opportunity.id}-BACKEND`, kind: 'backend', title: `Implement ${opportunity.title} backend`, goal: 'Implement only the confirmed service/API/data requirements.', why: opportunity.userValue, dependencies: [`FEAT-${opportunity.id}-DESIGN`], affectedModules: opportunity.affectedAreas, designRequirements: [], implementationPlan: [...input.backendRequirements, ...input.dataRequirements], securityImpact: input.securityRequirements, acceptanceCriteria: ['API/data contract matches the approved feature blueprint', 'Authorization and validation fail closed'], requiredTests: ['Schema validation tests', 'Authorization negative tests', 'Persistence/integration tests'] }, opportunity),
    baseWorkItem({ id: `FEAT-${opportunity.id}-INTEGRATE`, kind: 'qa', title: `Integrate and verify ${opportunity.title}`, goal: 'Integrate the approved frontend/backend slices and verify the complete product workflow.', why: 'A feature is not complete until the integrated workflow is proven against acceptance criteria.', dependencies: [`FEAT-${opportunity.id}-FRONTEND`, `FEAT-${opportunity.id}-BACKEND`], affectedModules: opportunity.affectedAreas, designRequirements: input.userFlow, implementationPlan: ['Connect approved frontend and backend slices', 'Run native regression tests', 'Run Beta.7 evidence-rich QA'], securityImpact: input.securityRequirements, acceptanceCriteria: ['All approved acceptance criteria pass', 'No unresolved critical/high regression is silently accepted', 'Beta.7 report is generated'], requiredTests: ['Native full regression', 'Beta.7 functional/visual/responsive QA'] }, opportunity),
  ];

  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), project: input.session.project, opportunityId: opportunity.id, selectedAlternative,
    architectureReview: input.session.architectureReview,
    userFlow: input.userFlow, informationArchitecture: input.informationArchitecture, frontendRequirements: input.frontendRequirements,
    backendRequirements: input.backendRequirements, dataRequirements: input.dataRequirements, securityRequirements: input.securityRequirements,
    accessibilityRequirements: ['Keyboard-accessible interaction', 'Discoverable accessible names', 'Focus/state changes are programmatically exposed'],
    responsiveRequirements: ['Reuse the current product breakpoints and responsive component behavior unless explicitly approved otherwise'],
    emptyLoadingErrorStates: ['Define explicit empty, loading, recoverable error, permission-denied and destructive-confirmation states where applicable'],
    analyticsRequirements: ['Collect only explicitly approved, privacy-bounded product metrics needed to evaluate the feature goal'],
    acceptanceCriteria: tasks.flatMap((task) => task.acceptanceCriteria),
    workPlan: { schemaVersion: 1, generatedAt: new Date().toISOString(), project: input.session.project, purpose: `Feature plan: ${opportunity.title}`, items: tasks },
  };
}
