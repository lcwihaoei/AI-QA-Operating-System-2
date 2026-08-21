import type { PlannedCandidate } from '../core/types.js';

export interface ExplorationSelection {
  navigation: PlannedCandidate[];
  interactions: PlannedCandidate[];
}

export interface ExplorationSelectionBudget {
  /** Remaining global browser-action budget after the current navigation/action. */
  remainingActions?: number;
  /** Number of distinct route families not yet represented by visited/queued coverage. */
  routeBreadthPressure?: number;
}

function routeFamily(plan: PlannedCandidate): string {
  const href = plan.candidate.href;
  if (!href) return `candidate:${plan.candidate.id}`;
  try {
    const url = new URL(href);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments[0] ? `/${segments[0].toLowerCase()}` : '/';
  } catch {
    return href.split(/[?#]/, 1)[0]?.split('/').filter(Boolean)[0]?.toLowerCase() ?? href;
  }
}

function balancedNavigation(links: PlannedCandidate[], quota: number): PlannedCandidate[] {
  if (quota <= 0) return [];
  const selected: PlannedCandidate[] = [];
  const usedIds = new Set<string>();
  const seenFamilies = new Set<string>();

  for (const plan of links) {
    if (selected.length >= quota) break;
    const family = routeFamily(plan);
    if (seenFamilies.has(family)) continue;
    selected.push(plan);
    usedIds.add(plan.candidate.id);
    seenFamilies.add(family);
  }

  for (const plan of links) {
    if (selected.length >= quota) break;
    if (usedIds.has(plan.candidate.id)) continue;
    selected.push(plan);
    usedIds.add(plan.candidate.id);
  }
  return selected;
}

function balancedInteractions(interactions: PlannedCandidate[], quota: number): PlannedCandidate[] {
  if (quota <= 0) return [];
  const selected: PlannedCandidate[] = [];
  const used = new Set<string>();
  const firstButton = interactions.find((plan) => plan.candidate.kind === 'button');
  if (firstButton) {
    selected.push(firstButton);
    used.add(firstButton.candidate.id);
  }
  const firstField = interactions.find((plan) => plan.candidate.kind === 'field' && !used.has(plan.candidate.id));
  if (selected.length < quota && firstField) {
    selected.push(firstField);
    used.add(firstField.candidate.id);
  }
  for (const plan of interactions) {
    if (selected.length >= quota) break;
    if (used.has(plan.candidate.id)) continue;
    selected.push(plan);
    used.add(plan.candidate.id);
  }
  return selected;
}

function boundedSelectionLimit(limit: number, budget?: ExplorationSelectionBudget): number {
  const requested = Math.max(1, Math.min(Math.floor(limit), 100));
  if (budget?.remainingActions === undefined) return requested;
  return Math.max(1, Math.min(requested, Math.max(1, Math.floor(budget.remainingActions))));
}

function distinctRouteFamilies(links: PlannedCandidate[]): number {
  return new Set(links.map(routeFamily)).size;
}

/**
 * Keep route discovery and real interaction probing from starving each other.
 *
 * Beta.9 reserved at most three interactions per planning round. That was safe
 * but made interaction-rich applications plateau at shallow coverage even when
 * the global action budget had ample capacity. Beta.10 instead computes a
 * bounded dynamic split. Navigation keeps enough slots to represent route
 * families, while the remaining capacity may be used by safe interactions.
 * The caller can further constrain the split with the remaining global action
 * budget and route-breadth pressure. Deterministic risk policy remains
 * authoritative because this function only sees already-allowed plans.
 */
export function selectExplorationPlans(
  plans: PlannedCandidate[],
  limit: number,
  budget?: ExplorationSelectionBudget,
): ExplorationSelection {
  const boundedLimit = boundedSelectionLimit(limit, budget);
  const allowed = plans.filter((plan) => plan.decision.allowed);
  const links = allowed.filter((plan) => plan.candidate.kind === 'link' && Boolean(plan.candidate.href));
  const interactions = allowed.filter((plan) => plan.candidate.kind !== 'link');

  if (links.length === 0) return { navigation: [], interactions: balancedInteractions(interactions, boundedLimit) };
  if (interactions.length === 0) return { navigation: balancedNavigation(links, boundedLimit), interactions: [] };
  if (boundedLimit === 1) return { navigation: balancedNavigation(links, 1), interactions: [] };

  const familyCount = distinctRouteFamilies(links);
  const requestedBreadth = Math.max(1, Math.min(
    familyCount,
    budget?.routeBreadthPressure ?? familyCount,
  ));
  // Reserve no more than half the current slice for breadth when interactions
  // are waiting. This guarantees at least one navigation slot while allowing
  // interaction-rich pages to use substantially more than the old 3-slot cap.
  const navigationFloor = Math.max(1, Math.min(requestedBreadth, Math.ceil(boundedLimit * 0.5)));
  const navigationQuota = Math.min(links.length, navigationFloor);
  const interactionQuota = Math.min(interactions.length, Math.max(1, boundedLimit - navigationQuota));

  let selectedInteractions = balancedInteractions(interactions, interactionQuota);
  let selectedNavigation = balancedNavigation(links, navigationQuota);
  let remaining = boundedLimit - selectedInteractions.length - selectedNavigation.length;

  if (remaining > 0) {
    const used = new Set(selectedNavigation.map((plan) => plan.candidate.id));
    const moreLinks = links.filter((plan) => !used.has(plan.candidate.id)).slice(0, remaining);
    selectedNavigation = [...selectedNavigation, ...moreLinks];
    remaining -= moreLinks.length;
  }
  if (remaining > 0) {
    const used = new Set(selectedInteractions.map((plan) => plan.candidate.id));
    selectedInteractions = [
      ...selectedInteractions,
      ...interactions.filter((plan) => !used.has(plan.candidate.id)).slice(0, remaining),
    ];
  }

  return { navigation: selectedNavigation, interactions: selectedInteractions };
}
