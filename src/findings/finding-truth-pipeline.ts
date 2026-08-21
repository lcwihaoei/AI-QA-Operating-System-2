import {
  assertEvidenceTruthAssessment,
  type AnnotationStatus,
  type EvidenceTruthAssessment,
  type FindingVerdict,
  type ReproductionStatus,
} from '../contracts/quality-contracts.js';
import type { QaEvent } from '../core/types.js';
import { validateOffscreenAnnotation, validateOverlapAnnotation, type AnnotationRect } from '../evidence/annotation-validator.js';
import { judgeFinding } from './finding-judge.js';
import { observePageVisibility } from '../state/page-state-observer.js';

const REPRODUCTION_STATUSES = new Set<ReproductionStatus>(['confirmed', 'not-reproduced', 'not-run', 'blocked']);

function stringDetail(event: QaEvent, key: string): string | undefined {
  const value = event.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberDetail(event: QaEvent, key: string): number | undefined {
  const value = event.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanDetail(event: QaEvent, key: string): boolean | undefined {
  const value = event.details?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function rect(value: unknown): AnnotationRect | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const x = typeof source.x === 'number' && Number.isFinite(source.x) ? source.x : undefined;
  const y = typeof source.y === 'number' && Number.isFinite(source.y) ? source.y : undefined;
  const width = typeof source.width === 'number' && Number.isFinite(source.width) ? source.width : undefined;
  const height = typeof source.height === 'number' && Number.isFinite(source.height) ? source.height : undefined;
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

function reproductionStatus(event: QaEvent): ReproductionStatus {
  const value = stringDetail(event, 'reproductionStatus');
  return value && REPRODUCTION_STATUSES.has(value as ReproductionStatus) ? value as ReproductionStatus : 'not-run';
}

function annotationStatus(event: QaEvent, primary: AnnotationRect | undefined, related: AnnotationRect | undefined): { status: AnnotationStatus; reason?: string } {
  const kind = stringDetail(event, 'visualKind');
  const viewportWidth = numberDetail(event, 'viewportWidth');
  const viewportHeight = numberDetail(event, 'viewportHeight');

  if (kind === 'interactive-offscreen') {
    if (!primary || !viewportWidth || !viewportHeight) {
      return { status: 'unverified', reason: 'offscreen annotation lacks complete element/viewport geometry' };
    }
    const checked = validateOffscreenAnnotation(primary, viewportWidth, viewportHeight);
    return { status: checked.status, reason: checked.reason };
  }

  if (kind === 'interactive-overlap') {
    if (!primary || !related || !viewportWidth || !viewportHeight) {
      return { status: 'unverified', reason: 'overlap annotation lacks both element rectangles or viewport geometry' };
    }
    const checked = validateOverlapAnnotation(primary, related, viewportWidth, viewportHeight);
    return { status: checked.status, reason: checked.reason };
  }

  return { status: 'not-applicable', reason: 'this detector does not require a geometric overlay to establish its evidence semantics' };
}

function boundedVerdictForEvidence(verdict: FindingVerdict, screenshotAvailable: boolean): FindingVerdict {
  if (verdict === 'confirmed-product-defect' && !screenshotAvailable) return 'potential-product-defect';
  return verdict;
}

export function applyFindingTruth(events: QaEvent[]): QaEvent[] {
  return events.map((event) => {
    if (event.kind !== 'ui' || event.details?.visual !== true) return event;

    const kind = stringDetail(event, 'visualKind') ?? 'unknown-visual-detector';
    const primary = rect(event.details?.rect);
    const related = rect(event.details?.relatedRect);
    const viewportWidth = numberDetail(event, 'viewportWidth');
    const viewportHeight = numberDetail(event, 'viewportHeight');
    const state = observePageVisibility({
      stateId: `${event.timestamp}|${kind}|${stringDetail(event, 'element') ?? 'document'}`,
      url: event.url,
      observedAt: event.timestamp,
      rect: primary,
      viewportWidth,
      viewportHeight,
      display: stringDetail(event, 'display'),
      cssVisibility: stringDetail(event, 'cssVisibility'),
      opacity: numberDetail(event, 'opacity'),
      hiddenAttribute: booleanDetail(event, 'hiddenAttribute'),
      inert: booleanDetail(event, 'inert'),
      ariaHidden: booleanDetail(event, 'ariaHidden'),
      controlledBy: stringDetail(event, 'controlledBy'),
      ownerExpanded: booleanDetail(event, 'ownerExpanded'),
      transformed: booleanDetail(event, 'transformed'),
    });
    const annotation = annotationStatus(event, primary, related);
    const reproduction = reproductionStatus(event);
    const judged = judgeFinding({
      detector: kind,
      visibility: state.visibility,
      annotation: annotation.status,
      reproduction,
      testDefect: event.details?.testDefect === true,
      environment: event.details?.environment === true,
      uxOpportunity: event.details?.uxOpportunity === true,
    });

    const screenshot = typeof event.details?.screenshot === 'string' && event.details.screenshot.length > 0;
    const verdict = boundedVerdictForEvidence(judged.verdict, screenshot);
    const reproductionReason = stringDetail(event, 'reproductionReason');
    const reasons = [
      ...judged.reasons,
      ...state.reasons.map((reason) => `state: ${reason}`),
      ...(annotation.reason ? [`annotation: ${annotation.reason}`] : []),
      ...(reproductionReason ? [`reproduction: ${reproductionReason}`] : []),
      ...(!screenshot && judged.verdict === 'confirmed-product-defect'
        ? ['evidence: confirmed visual classification was downgraded because no screenshot evidence is available']
        : []),
    ];

    const truth: EvidenceTruthAssessment = {
      screenshot: screenshot ? 'available' : 'unavailable',
      ...(screenshot ? {} : { screenshotReason: stringDetail(event, 'screenshotReason') ?? 'visual signal has no screenshot evidence attached to the source event' }),
      annotation: annotation.status,
      reproduction,
      verdict,
      reasons,
    };
    assertEvidenceTruthAssessment(truth);

    return {
      ...event,
      details: {
        ...(event.details ?? {}),
        visibilityState: state.visibility,
        visibilityReasons: state.reasons,
        annotationStatus: annotation.status,
        annotationReason: annotation.reason,
        findingVerdict: verdict,
        findingConfidenceCeiling: judged.confidenceCeiling,
        truthAssessment: truth,
      },
    };
  });
}
