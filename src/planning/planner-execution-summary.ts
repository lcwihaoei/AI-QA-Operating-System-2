import type { ModelExecutionStatus } from '../contracts/quality-contracts.js';
import type { PlannerExecutionSummary, QaEvent } from '../core/types.js';

function modelStatus(event: QaEvent): ModelExecutionStatus | undefined {
  const value = event.details?.modelStatus;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Partial<ModelExecutionStatus>;
  if (typeof source.configured !== 'boolean' || typeof source.attempted !== 'boolean' || typeof source.used !== 'boolean') return undefined;
  return source as ModelExecutionStatus;
}

function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0] || url;
  }
}

export function summarizePlannerExecution(events: QaEvent[]): PlannerExecutionSummary {
  const plannerEvents = events
    .filter((event) => event.kind === 'planner' && event.message.startsWith('Planner ranked'))
    .map((event) => ({ event, status: modelStatus(event) }))
    .filter((item): item is { event: QaEvent; status: ModelExecutionStatus } => Boolean(item.status));

  const pagesObserved = new Set(plannerEvents.map(({ event }) => pageKey(event.url)));
  const attempted = new Set<string>();
  const used = new Set<string>();
  const fallback = new Set<string>();
  const providers = new Set<string>();
  let repairAttempts = 0;
  let failedCalls = 0;
  let configured = false;

  for (const { event, status } of plannerEvents) {
    const key = pageKey(event.url);
    configured ||= status.configured;
    if (status.attempted) attempted.add(key);
    if (status.used) used.add(key);
    if (status.fallbackUsed || status.outcome === 'fallback') fallback.add(key);
    if (status.repairAttempted) repairAttempts += 1;
    if (status.outcome === 'failed' || status.outcome === 'fallback') failedCalls += 1;
    if (status.provider) providers.add(status.provider);
  }

  let status: PlannerExecutionSummary['status'];
  if (!configured) status = 'not-configured';
  else if (attempted.size === 0) status = 'skipped';
  else if (used.size === 0) status = 'unavailable';
  else if (fallback.size > 0) status = 'partial-fallback';
  else status = 'active';

  return {
    configured,
    status,
    pagesObserved: pagesObserved.size,
    pagesAttempted: attempted.size,
    pagesModelUsed: used.size,
    pagesFallback: fallback.size,
    repairAttempts,
    failedCalls,
    providers: [...providers].sort(),
  };
}
