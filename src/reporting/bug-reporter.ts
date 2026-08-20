import { createHash } from 'node:crypto';
import type { Finding, FindingKind, QaEvent, Severity } from '../core/types.js';

function hintedSeverity(event: QaEvent): Severity | undefined {
  const hint = event.details?.severityHint;
  if (hint === 'high' || hint === 'medium' || hint === 'low' || hint === 'info') return hint;
  return undefined;
}

export function isToolingInteractionFailure(event: QaEvent): boolean {
  if (event.details?.tooling === true) return true;
  if (event.kind !== 'page-error') return false;
  return /^(Button probe failed|Synthetic field fill failed|Synthetic select failed):/i.test(event.message);
}

function severityFor(event: QaEvent): Severity {
  if (isToolingInteractionFailure(event)) return 'info';
  if (event.kind === 'page-error') return 'high';
  if (event.kind === 'network') {
    const status = Number(event.details?.status ?? 0);
    return status >= 500 ? 'high' : status >= 400 ? 'medium' : 'low';
  }
  if (event.kind === 'console') return 'medium';
  if (event.kind === 'assertion') return hintedSeverity(event) ?? 'medium';
  if (event.kind === 'ui') {
    const hint = hintedSeverity(event);
    if (hint === 'medium' || hint === 'low' || hint === 'info') return hint;
  }
  return 'low';
}

function titleFor(event: QaEvent): string {
  const visualKind = typeof event.details?.visualKind === 'string' ? event.details.visualKind : undefined;
  const browserUiKind = typeof event.details?.uiKind === 'string' ? event.details.uiKind : undefined;
  const uiKind = visualKind ?? browserUiKind;
  if (event.kind === 'ui' && uiKind) {
    switch (uiKind) {
      case 'horizontal-overflow': return 'Horizontal layout overflow';
      case 'interactive-offscreen': return 'Interactive control outside viewport';
      case 'text-clipping': return 'Visible text is clipped';
      case 'interactive-overlap': return 'Interactive controls overlap';
    }
  }

  if (event.kind === 'assertion' && event.details?.deviceDefect === 'app-terminated') return 'Mobile application terminated unexpectedly';
  if (event.kind === 'assertion' && event.details?.deviceDefect === 'crash-dialog') return 'Mobile crash dialog detected';
  if (event.kind === 'assertion' && event.details?.deviceDefect === 'anr-dialog') return 'Mobile application not responding';
  if (event.kind === 'assertion' && event.details?.semanticState === true) return 'UI state differs from successful API state';
  if (event.kind === 'assertion' && event.details?.api === true) return 'API contract or behavior violation';

  switch (event.kind) {
    case 'page-error': return 'Unhandled page error';
    case 'network': return 'Failed network request';
    case 'console': return 'Browser console error';
    case 'ui': return 'Potential UI defect';
    case 'assertion': return 'QA assertion failed';
    default: return 'QA finding';
  }
}

function correlationForEvent(events: QaEvent[], event: QaEvent): QaEvent | undefined {
  return events.find((candidate) => {
    if (candidate.kind !== 'correlation') return false;
    if (event.kind === 'network') return candidate.details?.networkTimestamp === event.timestamp;
    if (event.kind === 'assertion' && event.details?.api === true) {
      return candidate.details?.apiAssertionTimestamp === event.timestamp;
    }
    return false;
  });
}

function correlationReproduction(correlation: QaEvent | undefined): string[] | undefined {
  const value = correlation?.details?.reproduction;
  if (!Array.isArray(value)) return undefined;
  const steps = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return steps.length > 0 ? steps : undefined;
}

function semanticReproduction(event: QaEvent): string[] | undefined {
  if (event.details?.semanticState !== true) return undefined;
  const fieldKey = typeof event.details.fieldKey === 'string' ? event.details.fieldKey : 'matched field';
  const apiPath = typeof event.details.apiPath === 'string' ? event.details.apiPath : 'the recorded API endpoint';
  return [
    `Open ${event.url}`,
    `Observe the UI control associated with "${fieldKey}"`,
    `Request the successful read state from ${apiPath} using the same authenticated session`,
    'Compare the UI control state with the API state; values are compared by per-run salted hashes in evidence',
  ];
}

function deviceReproduction(event: QaEvent): string[] | undefined {
  if (typeof event.details?.deviceDefect !== 'string') return undefined;
  const platform = typeof event.details.platform === 'string' ? event.details.platform : 'mobile';
  const priorAction = typeof event.details.priorAction === 'string'
    ? event.details.priorAction
    : 'Repeat the recorded allowed mobile interaction';
  const observation = event.details.deviceDefect === 'app-terminated'
    ? 'Observe that the target application is no longer running immediately after the interaction'
    : event.details.deviceDefect === 'anr-dialog'
      ? 'Observe the operating-system application-not-responding dialog after the interaction'
      : 'Observe the operating-system crash/stopped dialog after the interaction';
  return [
    `Start the configured target ${platform} application in the Appium session`,
    priorAction,
    observation,
    'Compare the screenshot and device-state evidence recorded for the same action number',
  ];
}

export function fingerprintFinding(kind: string, url: string, message: string): string {
  return createHash('sha1')
    .update(`${kind}|${new URL(url).pathname}|${message.replace(/\d+/g, '#').slice(0, 500)}`)
    .digest('hex')
    .slice(0, 16);
}

function fingerprintForEvent(event: QaEvent): string {
  if (event.kind === 'ui' && event.details?.browserUi === true) {
    const uiKind = typeof event.details.uiKind === 'string' ? event.details.uiKind : 'browser-ui';
    const element = typeof event.details.element === 'string' ? event.details.element : event.message;
    return createHash('sha1')
      .update(`ui|shared-component|${uiKind}|${element.replace(/\d+/g, '#').slice(0, 500)}`)
      .digest('hex')
      .slice(0, 16);
  }
  return fingerprintFinding(event.kind, event.url, event.message);
}

export function findingsFromEvents(events: QaEvent[]): Finding[] {
  const relevant = events.filter((event) =>
    ['page-error', 'network', 'console', 'ui', 'assertion'].includes(event.kind) && !isToolingInteractionFailure(event));
  const byFingerprint = new Map<string, Finding>();

  for (const event of relevant) {
    const fingerprint = fingerprintForEvent(event);
    if (byFingerprint.has(fingerprint)) continue;
    const correlation = correlationForEvent(events, event);
    const directScreenshot = typeof event.details?.screenshot === 'string' ? event.details.screenshot : undefined;
    const correlatedScreenshot = typeof correlation?.details?.screenshot === 'string' ? correlation.details.screenshot : undefined;
    const screenshot = directScreenshot ?? correlatedScreenshot;
    const correlatedSteps = correlationReproduction(correlation);
    const reproduction = deviceReproduction(event) ?? semanticReproduction(event) ?? correlatedSteps ?? (event.details?.api === true
      ? [`Send the API request recorded immediately before this event to ${event.url}`, 'Compare the response with the OpenAPI contract recorded in events.json']
      : [`Open ${event.url}`, 'Repeat the action recorded immediately before the event in events.json']);

    byFingerprint.set(fingerprint, {
      id: `BUG-${String(byFingerprint.size + 1).padStart(4, '0')}`,
      kind: event.kind as FindingKind,
      severity: severityFor(event),
      title: titleFor(event),
      url: event.url,
      message: event.message,
      reproduction,
      evidence: screenshot ? [screenshot] : [],
      fingerprint,
    });
  }

  return [...byFingerprint.values()];
}
