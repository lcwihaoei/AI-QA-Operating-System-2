import type { QaRunResult } from '../core/types.js';

export type DogfoodVerificationStatus = 'PASS' | 'BLOCKED' | 'FAIL';
export type DogfoodCheckStatus = 'pass' | 'blocked' | 'fail';

export interface DogfoodVerificationCheck {
  id: string;
  status: DogfoodCheckStatus;
  message: string;
}

export interface DogfoodReportDataLike {
  run?: {
    pageCoverage?: number;
    rawInteractionCoverage?: number;
    eligibleInteractionCoverage?: number;
    unexplainedEligibleGaps?: number;
  };
  findings?: unknown[];
  findingClusters?: {
    rawFindings?: number;
    clusters?: number;
  };
}

export interface Beta10DogfoodVerifierOptions {
  requiredPaths?: string[];
  minEligibleCoverage?: number;
  minVideos?: number;
  requireModel?: boolean;
  requireUxReasoner?: boolean;
  reportData?: DogfoodReportDataLike;
  candidateSha?: string;
  expectedCandidateSha?: string;
  candidateVersion?: string;
  expectedVersion?: string;
}

export interface Beta10DogfoodVerification {
  status: DogfoodVerificationStatus;
  checks: DogfoodVerificationCheck[];
  metrics: {
    routeCoverage: number;
    eligibleInteractionCoverage: number;
    unexplainedEligibleGaps: number;
    rawFindings: number;
    clusters: number;
    videos: number;
    plannerStatus: string;
    uxReasonerOutcome: string;
  };
}

function pathname(value: string): string {
  try {
    return new URL(value).pathname || '/';
  } catch {
    return value.split(/[?#]/, 1)[0] || '/';
  }
}

function check(id: string, status: DogfoodCheckStatus, message: string): DogfoodVerificationCheck {
  return { id, status, message };
}

function collapsedSidebarRegressionCount(result: QaRunResult): number {
  const collapsedPattern = /(app-tab-content|app-menubar-tabs|appMenubar|side-menubar|navbar-brand-text|menu-link)/i;
  const defectPattern = /(offscreen|unreachable|clipped|overlap|outside viewport)/i;
  return result.events.filter((event) => {
    const haystack = `${event.message || ''} ${String(event.details?.element ?? '')} ${String(event.details?.relatedElement ?? '')}`;
    return event.kind === 'ui' && collapsedPattern.test(haystack) && defectPattern.test(haystack);
  }).length;
}

export function verifyBeta10Dogfood(
  result: QaRunResult,
  options: Beta10DogfoodVerifierOptions = {},
): Beta10DogfoodVerification {
  const requiredPaths = options.requiredPaths ?? ['/'];
  const minEligibleCoverage = options.minEligibleCoverage ?? 80;
  const minVideos = options.minVideos ?? 3;
  const checks: DogfoodVerificationCheck[] = [];
  const visitedPaths = new Set(result.visitedUrls.map(pathname));
  const missingPaths = requiredPaths.filter((required) => !visitedPaths.has(required));
  checks.push(check(
    'route-coverage',
    missingPaths.length === 0 ? 'pass' : 'fail',
    missingPaths.length === 0
      ? `all ${requiredPaths.length} required route(s) were visited`
      : `missing required route(s): ${missingPaths.join(', ')}`,
  ));

  const eligibleCoverage = result.coverage.eligibleInteractionCoverage ?? result.coverage.interactionCoverage;
  checks.push(check(
    'eligible-interaction-coverage',
    eligibleCoverage >= minEligibleCoverage ? 'pass' : 'fail',
    `${eligibleCoverage}% eligible interaction coverage; target is >=${minEligibleCoverage}%`,
  ));

  const unexplained = result.coverage.unexplainedEligibleGaps ?? 0;
  checks.push(check(
    'unexplained-eligible-gaps',
    unexplained === 0 ? 'pass' : 'fail',
    unexplained === 0 ? 'zero unexplained eligible gaps' : `${unexplained} unexplained eligible gap(s) remain`,
  ));

  const clusters = result.findingClusters;
  const clusterCardinalityValid = Boolean(clusters && clusters.rawFindings === result.findings.length
    && clusters.items.flatMap((item) => item.memberFindingIds).length === result.findings.length);
  checks.push(check(
    'finding-cluster-cardinality',
    clusterCardinalityValid ? 'pass' : 'fail',
    clusterCardinalityValid
      ? `${result.findings.length} raw finding(s) preserved across ${clusters?.clusters ?? 0} cluster(s)`
      : 'finding clusters are missing or do not preserve raw finding cardinality',
  ));

  const collapsedRegressions = collapsedSidebarRegressionCount(result);
  checks.push(check(
    'collapsed-sidebar-regression',
    collapsedRegressions === 0 ? 'pass' : 'fail',
    collapsedRegressions === 0
      ? 'no historical collapsed/off-canvas defect-pattern event was emitted'
      : `${collapsedRegressions} collapsed/off-canvas defect-pattern event(s) remain`,
  ));

  const videos = result.report?.videos ?? 0;
  const reportReady = Boolean(result.report?.enabled && result.report.htmlPath && result.report.dataPath && videos >= minVideos);
  checks.push(check(
    'evidence-report',
    reportReady ? 'pass' : 'fail',
    reportReady
      ? `evidence report enabled with ${videos} video(s)`
      : `report/video contract not met; expected enabled report and at least ${minVideos} video(s)`,
  ));

  const planner = result.planner;
  if (options.requireModel) {
    if (!planner?.configured || planner.status === 'not-configured' || planner.status === 'skipped') {
      checks.push(check('planner-model', 'blocked', 'model-required dogfood cannot prove planner participation because the model was not configured/attempted'));
    } else if (planner.status === 'unavailable') {
      checks.push(check('planner-model', 'fail', `planner model was configured but unavailable across all attempted pages (${planner.pagesAttempted} attempted)`));
    } else {
      checks.push(check('planner-model', 'pass', `planner status ${planner.status}; model used on ${planner.pagesModelUsed}/${planner.pagesAttempted} attempted page(s), fallback on ${planner.pagesFallback}`));
    }
  } else {
    checks.push(check('planner-model', 'pass', `planner status ${planner?.status ?? 'legacy-result-without-summary'}; model participation is not required for this verifier run`));
  }

  const uxReasoner = result.ux?.reasonerStatus;
  if (options.requireUxReasoner) {
    if (!uxReasoner) {
      checks.push(check('ux-reasoner', 'blocked', 'UX reasoner status is absent from this result'));
    } else if (!uxReasoner.configured) {
      checks.push(check('ux-reasoner', 'blocked', 'UX reasoner is required but was not configured'));
    } else if (!uxReasoner.attempted && uxReasoner.outcome !== 'skipped') {
      checks.push(check('ux-reasoner', 'fail', `UX reasoner configured state is not auditable: outcome=${uxReasoner.outcome}`));
    } else {
      checks.push(check('ux-reasoner', 'pass', `UX reasoner outcome is explicit: ${uxReasoner.outcome}${uxReasoner.error ? ' with bounded failure diagnostic' : ''}`));
    }
  } else {
    checks.push(check('ux-reasoner', 'pass', `UX reasoner outcome ${uxReasoner?.outcome ?? 'not-present'}; reasoner participation is not required for this verifier run`));
  }

  if (options.expectedCandidateSha) {
    if (!options.candidateSha) checks.push(check('candidate-sha', 'blocked', 'expected candidate SHA was supplied but actual candidate SHA metadata is missing'));
    else checks.push(check('candidate-sha', options.candidateSha === options.expectedCandidateSha ? 'pass' : 'fail',
      options.candidateSha === options.expectedCandidateSha ? `candidate SHA matches ${options.expectedCandidateSha}` : `candidate SHA ${options.candidateSha} does not match expected ${options.expectedCandidateSha}`));
  }
  if (options.expectedVersion) {
    if (!options.candidateVersion) checks.push(check('candidate-version', 'blocked', 'expected candidate version was supplied but actual version metadata is missing'));
    else checks.push(check('candidate-version', options.candidateVersion === options.expectedVersion ? 'pass' : 'fail',
      options.candidateVersion === options.expectedVersion ? `candidate version matches ${options.expectedVersion}` : `candidate version ${options.candidateVersion} does not match expected ${options.expectedVersion}`));
  }

  if (options.reportData) {
    const data = options.reportData;
    const reportFindings = Array.isArray(data.findings) ? data.findings.length : undefined;
    const consistent = data.run?.pageCoverage === result.coverage.pageCoverage
      && data.run?.rawInteractionCoverage === (result.coverage.rawInteractionCoverage ?? result.coverage.interactionCoverage)
      && data.run?.eligibleInteractionCoverage === eligibleCoverage
      && data.run?.unexplainedEligibleGaps === unexplained
      && reportFindings === result.findings.length
      && data.findingClusters?.rawFindings === result.findings.length
      && data.findingClusters?.clusters === result.findingClusters?.clusters;
    checks.push(check(
      'report-metric-consistency',
      consistent ? 'pass' : 'fail',
      consistent ? 'report-data metrics agree with result.json' : 'report-data metrics do not agree with result.json',
    ));
  } else {
    checks.push(check('report-metric-consistency', 'blocked', 'report-data.json was not supplied to the verifier'));
  }

  const status: DogfoodVerificationStatus = checks.some((item) => item.status === 'fail')
    ? 'FAIL'
    : checks.some((item) => item.status === 'blocked')
      ? 'BLOCKED'
      : 'PASS';

  return {
    status,
    checks,
    metrics: {
      routeCoverage: result.coverage.pageCoverage,
      eligibleInteractionCoverage: eligibleCoverage,
      unexplainedEligibleGaps: unexplained,
      rawFindings: result.findings.length,
      clusters: result.findingClusters?.clusters ?? 0,
      videos,
      plannerStatus: result.planner?.status ?? 'unknown',
      uxReasonerOutcome: result.ux?.reasonerStatus?.outcome ?? 'unknown',
    },
  };
}
