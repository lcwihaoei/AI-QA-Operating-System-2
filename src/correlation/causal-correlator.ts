import type { CausalCorrelationSummary, QaEvent } from '../core/types.js';

type Confidence = 'high' | 'medium';

export interface CausalCorrelationResult {
  events: QaEvent[];
  summary: CausalCorrelationSummary;
}

const ACTION_WINDOW_MS = 3_000;
const OUTCOME_WINDOW_MS = 3_500;

function millis(event: QaEvent): number {
  const value = Date.parse(event.timestamp);
  return Number.isFinite(value) ? value : 0;
}

function stringDetail(event: QaEvent, key: string): string | undefined {
  const value = event.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberDetail(event: QaEvent, key: string): number | undefined {
  const value = event.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function browserAction(event: QaEvent): boolean {
  return event.kind === 'action' && event.details?.api !== true;
}

function browserNetworkFailure(event: QaEvent): boolean {
  return event.kind === 'network' && event.details?.api !== true && (numberDetail(event, 'status') ?? 0) >= 400;
}

function apiAssertion(event: QaEvent): boolean {
  return event.kind === 'assertion' && event.details?.api === true;
}

function openApiPathMatches(template: string, actualPath: string): boolean {
  const escaped = template
    .split('/')
    .map((segment) => /^\{[^}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('/');
  return new RegExp(`^${escaped}$`).test(actualPath);
}

function apiMatchesNetwork(apiEvent: QaEvent, networkEvent: QaEvent): boolean {
  const apiMethod = stringDetail(apiEvent, 'method');
  const networkMethod = stringDetail(networkEvent, 'method');
  const apiPath = stringDetail(apiEvent, 'path');
  if (!apiMethod || !networkMethod || !apiPath || apiMethod.toUpperCase() !== networkMethod.toUpperCase()) return false;
  try {
    return openApiPathMatches(apiPath, new URL(networkEvent.url).pathname);
  } catch {
    return false;
  }
}

function nearestAction(actions: QaEvent[], target: QaEvent): QaEvent | undefined {
  const targetMs = millis(target);
  let best: QaEvent | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const action of actions) {
    const delta = targetMs - millis(action);
    if (delta < 0 || delta > ACTION_WINDOW_MS || delta >= bestDelta) continue;
    best = action;
    bestDelta = delta;
  }
  return best;
}

function relatedSnapshot(snapshots: QaEvent[], action: QaEvent, network: QaEvent): QaEvent | undefined {
  const candidateId = stringDetail(action, 'candidateId');
  const actionMs = millis(action);
  const networkMs = millis(network);
  return snapshots.find((snapshot) => {
    const time = millis(snapshot);
    if (time < actionMs || time - actionMs > OUTCOME_WINDOW_MS) return false;
    const snapshotCandidateId = stringDetail(snapshot, 'candidateId');
    if (candidateId && snapshotCandidateId) return candidateId === snapshotCandidateId;
    return time >= networkMs && time - networkMs <= OUTCOME_WINDOW_MS;
  });
}

function relatedUiOutcome(uiEvents: QaEvent[], action: QaEvent, network: QaEvent): QaEvent | undefined {
  const start = Math.max(millis(action), millis(network));
  return uiEvents.find((event) => {
    const time = millis(event);
    return time >= start && time - start <= OUTCOME_WINDOW_MS;
  });
}

export class CausalCorrelator {
  correlate(browserEvents: QaEvent[], apiEvents: QaEvent[]): CausalCorrelationResult {
    const actions = browserEvents.filter(browserAction);
    const failures = browserEvents.filter(browserNetworkFailure);
    const snapshots = browserEvents.filter((event) => event.kind === 'snapshot' && typeof event.details?.screenshot === 'string');
    const uiEvents = browserEvents.filter((event) => event.kind === 'ui');
    const assertions = apiEvents.filter(apiAssertion);
    const correlationEvents: QaEvent[] = [];
    let highConfidence = 0;
    let apiMatched = 0;

    for (const network of failures) {
      const action = nearestAction(actions, network);
      if (!action) continue;
      const api = assertions.find((event) => apiMatchesNetwork(event, network));
      const screenshot = relatedSnapshot(snapshots, action, network);
      const uiOutcome = relatedUiOutcome(uiEvents, action, network);
      const status = numberDetail(network, 'status');
      const method = stringDetail(network, 'method') ?? 'HTTP';
      const candidateId = stringDetail(action, 'candidateId');
      const confidence: Confidence = api ? 'high' : 'medium';
      if (api) apiMatched += 1;
      if (confidence === 'high') highConfidence += 1;

      const reproduction = [
        action.message,
        `${method} ${network.url}${status ? ` returned ${status}` : ' failed'}`,
      ];
      if (api) reproduction.push(api.message);
      if (uiOutcome) reproduction.push(`UI outcome: ${uiOutcome.message}`);

      correlationEvents.push({
        timestamp: new Date(Math.max(millis(network), millis(api ?? network), millis(uiOutcome ?? network)) + 1).toISOString(),
        kind: 'correlation',
        url: network.url,
        message: api
          ? `Browser action correlated with network failure and OpenAPI/API finding: ${method} ${new URL(network.url).pathname}`
          : `Browser action correlated with network failure: ${method} ${new URL(network.url).pathname}`,
        details: {
          causal: true,
          confidence,
          browserActionTimestamp: action.timestamp,
          browserAction: action.message,
          candidateId,
          networkTimestamp: network.timestamp,
          networkMethod: method,
          networkStatus: status,
          networkUrl: network.url,
          apiAssertionTimestamp: api?.timestamp,
          apiAssertion: api?.message,
          operationId: api ? stringDetail(api, 'operationId') : undefined,
          uiOutcomeTimestamp: uiOutcome?.timestamp,
          uiOutcome: uiOutcome?.message,
          screenshot: typeof screenshot?.details?.screenshot === 'string' ? screenshot.details.screenshot : undefined,
          reproduction,
        },
      });
    }

    return {
      events: correlationEvents,
      summary: {
        chains: correlationEvents.length,
        highConfidence,
        apiMatched,
        browserNetworkFailures: failures.length,
      },
    };
  }
}
