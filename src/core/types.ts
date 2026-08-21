import type { EvidenceTruthAssessment, ModelExecutionStatus } from '../contracts/quality-contracts.js';
import type { DeviceMode, DevicePlatform } from '../device/device-provider.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingKind = 'console' | 'page-error' | 'network' | 'ui' | 'navigation' | 'assertion';
export type RiskMode = 'safe' | 'standard';
export type CandidateKind = 'link' | 'button' | 'field';
export type CandidateRisk = 'low' | 'medium' | 'blocked';
export type VisualViewportName = 'desktop' | 'tablet' | 'mobile';
export type ApiMode = 'off' | 'discover' | 'safe' | 'sandbox';
export type OpenApiSchemaFormat = 'json' | 'yaml';
export type UxLearningStatus = 'untracked' | 'improved' | 'regressed' | 'stable';

export interface QaRunOptions {
  url: string;
  maxActions: number;
  maxDepth: number;
  maxCandidatesPerPage: number;
  headless: boolean;
  outputDir: string;
  sameOriginOnly: boolean;
  riskMode: RiskMode;
  visualViewports: VisualViewportName[];
  routeSeeds?: string[];
  plannerEndpoint?: string;
  plannerToken?: string;
  visualEndpoint?: string;
  visualToken?: string;
  visualBaselinePath?: string;
  updateVisualBaseline?: boolean;
  apiMode?: ApiMode;
  maxApiOperations?: number;
  confirmDisposableTarget?: boolean;
  semanticState?: boolean;
  deviceMode?: DeviceMode;
  devicePlatform?: DevicePlatform;
  deviceMaxActions?: number;
  appiumEndpoint?: string;
  appiumToken?: string;
  deviceCapabilities?: Record<string, unknown>;
  githubQa?: boolean;
  githubMemoryPath?: string;
  updateGithubMemory?: boolean;
  controlPlanePath?: string;
  uxIntelligence?: boolean;
  uxEndpoint?: string;
  uxToken?: string;
  uxMemoryPath?: string;
  uxProductKey?: string;
  updateUxMemory?: boolean;
  minimaxApiKey?: string;
  minimaxModel?: string;
  minimaxBaseUrl?: string;
  evidenceReport?: boolean;
  recordVideo?: boolean;
}

export interface ExplorationCandidate {
  id: string;
  kind: CandidateKind;
  label: string;
  href?: string;
  locatorIndex: number;
  tagName: string;
  role?: string;
  type?: string;
  formAction?: string;
  name?: string;
  placeholder?: string;
  autocomplete?: string;
}

export interface CandidateDecision {
  risk: CandidateRisk;
  allowed: boolean;
  interestScore: number;
  reasons: string[];
}

export interface PlannedCandidate {
  candidate: ExplorationCandidate;
  decision: CandidateDecision;
  score: number;
}

export type CoverageTerminalReason =
  | 'state-invalidated'
  | 'stale-candidate'
  | 'unsupported-field'
  | 'navigation-depth-limit'
  | 'route-already-covered'
  | 'route-already-queued'
  | 'interaction-round-budget-exhausted'
  | 'action-budget-exhausted';

export interface CoverageTerminalGap {
  scope: 'interaction';
  url: string;
  candidateId: string;
  label: string;
  reason: CoverageTerminalReason;
  explained: true;
}

export interface CoveragePageSnapshot {
  url: string;
  depth: number;
  visited: boolean;
  visits: number;
  discoveredCandidates: number;
  actionableCandidates: number;
  eligibleCandidates?: number;
  exercisedCandidates: number;
  terminalEligibleCandidates?: number;
  unexplainedEligibleCandidates?: number;
  blockedCandidates: number;
  errors: number;
}

export interface CoverageSnapshot {
  score: number;
  pageCoverage: number;
  interactionCoverage: number;
  eligibleInteractions?: number;
  exercisedEligibleInteractions?: number;
  explainedEligibleGaps?: number;
  unexplainedEligibleGaps?: number;
  pages: CoveragePageSnapshot[];
  gaps: string[];
  terminalGaps?: CoverageTerminalGap[];
}

export interface VisualBaselineSummary {
  enabled: boolean;
  path?: string;
  existed: boolean;
  newSignals: number;
  persistentSignals: number;
  resolvedSignals: number;
  updated: boolean;
  error?: string;
}

export interface ApiQaSummary {
  enabled: boolean;
  mode: ApiMode;
  schemaUrl?: string;
  schemaFormat?: OpenApiSchemaFormat;
  operationsDiscovered: number;
  operationsTested: number;
  operationsSkipped: number;
  statefulOperationsTested?: number;
  statefulScenariosPlanned?: number;
  statefulScenariosCompleted?: number;
  cleanupAttempts?: number;
  cleanupFailures?: number;
  toolingError?: string;
}

export interface CausalCorrelationSummary {
  chains: number;
  highConfidence: number;
  apiMatched: number;
  browserNetworkFailures: number;
}

export interface SemanticStateSummary {
  enabled: boolean;
  apiFactsObserved: number;
  uiFieldsObserved: number;
  comparisons: number;
  matches: number;
  mismatches: number;
  ambiguousSkipped: number;
  toolingError?: string;
}

export interface DeviceQaSummary {
  enabled: boolean;
  mode: DeviceMode;
  platform?: DevicePlatform;
  provider?: string;
  sessionStarted: boolean;
  screenshotCaptured: boolean;
  pageSourceChars: number;
  elementEstimate: number;
  candidatesObserved: number;
  blockedCandidates: number;
  outsideAppCandidates: number;
  appBoundaryDeclared: boolean;
  appBoundaryObserved: boolean;
  appStateChecks: number;
  appTerminationFindings: number;
  crashDialogFindings: number;
  logOracleEnabled: boolean;
  logChecks: number;
  logCrashFindings: number;
  actions: number;
  cleanupAttempted: boolean;
  cleanupFailed: boolean;
  toolingError?: string;
}

export interface GitHubQaSummary {
  enabled: boolean;
  memoryPath?: string;
  planPath?: string;
  memoryExisted: boolean;
  untracked: number;
  newIssues: number;
  persistent: number;
  resolved: number;
  memoryUpdated: boolean;
  toolingError?: string;
}

export interface ControlPlaneSummary {
  enabled: boolean;
  statePath?: string;
  runRecorded: boolean;
  toolingError?: string;
}

export interface UxIntelligenceSummary {
  enabled: boolean;
  pagesAttempted: number;
  pagesAnalyzed: number;
  pagesFailed: number;
  completeness: number;
  valid: boolean;
  score: number;
  opportunities: number;
  highImpact: number;
  mediumImpact: number;
  lowImpact: number;
  reasonerStatus: ModelExecutionStatus;
  /** @deprecated Read reasonerStatus.used. Kept for Beta.9 result compatibility. */
  reasonerUsed: boolean;
  opportunityPath?: string;
  toolingError?: string;
}

export interface UxLearningSummary {
  enabled: boolean;
  productKey?: string;
  memoryPath?: string;
  memoryExisted: boolean;
  status: UxLearningStatus;
  baselineScore?: number;
  currentScore?: number;
  delta?: number;
  memoryUpdated: boolean;
  toolingError?: string;
}

export interface ReproductionSummary {
  enabled: boolean;
  eligible: number;
  attempted: number;
  confirmed: number;
  notReproduced: number;
  blocked: number;
  notRun: number;
  maxAttempts: number;
  toolingError?: string;
}

export interface QaReportSummary {
  enabled: boolean;
  htmlPath?: string;
  dataPath?: string;
  markdownPath?: string;
  videos: number;
  findings: number;
  uxOpportunities: number;
  toolingError?: string;
}

export interface QaEvent {
  timestamp: string;
  kind: FindingKind | 'action' | 'snapshot' | 'planner' | 'correlation';
  url: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  url: string;
  message: string;
  reproduction: string[];
  evidence: string[];
  fingerprint: string;
  truth?: EvidenceTruthAssessment;
}

export interface QaRunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  visitedUrls: string[];
  actions: number;
  events: QaEvent[];
  findings: Finding[];
  coverage: CoverageSnapshot;
  visualBaseline: VisualBaselineSummary;
  api: ApiQaSummary;
  correlation: CausalCorrelationSummary;
  semanticState: SemanticStateSummary;
  device: DeviceQaSummary;
  reproduction?: ReproductionSummary;
  githubQa?: GitHubQaSummary;
  controlPlane?: ControlPlaneSummary;
  ux?: UxIntelligenceSummary;
  uxLearning?: UxLearningSummary;
  report?: QaReportSummary;
  outputDir: string;
}
