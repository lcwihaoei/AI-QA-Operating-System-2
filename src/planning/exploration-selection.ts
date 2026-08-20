import type { PlannedCandidate } from '../core/types.js';

export interface ExplorationSelection {
  navigation: PlannedCandidate[];
  interactions: PlannedCandidate[];
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

  // First pass: take the highest-ranked representative of each top-level route
  // family. This prevents /settings/* from consuming the whole page budget while
  // /learning, /vocabulary or /practice remain untouched.
  for (const plan of links) {
    if (selected.length >= quota) break;
    const family = routeFamily(plan);
    if (seenFamilies.has(family)) continue;
    selected.push(plan);
    usedIds.add(plan.candidate.id);
    seenFamilies.add(family);
  }

  // Second pass: fill unused capacity by the planner's original ranking.
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

/**
 * Keep route discovery and real interaction probing from starving each other.
 *
 * The planner may rank many candidates of one kind or route family above the
 * others. Taking a single top-N slice therefore turns a nominal BFS crawl into
 * a narrow route chain, or prevents buttons from ever being clicked. This
 * selector reserves capacity for both safe navigation and non-link
 * interactions, diversifies navigation by top-level route family, and reserves
 * a button slot when an allowed button exists.
 */
export function selectExplorationPlans(plans: PlannedCandidate[], limit: number): ExplorationSelection {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const allowed = plans.filter((plan) => plan.decision.allowed);
  const links = allowed.filter((plan) => plan.candidate.kind === 'link' && Boolean(plan.candidate.href));
  const interactions = allowed.filter((plan) => plan.candidate.kind !== 'link');

  if (links.length === 0) return { navigation: [], interactions: balancedInteractions(interactions, boundedLimit) };
  if (interactions.length === 0) return { navigation: balancedNavigation(links, boundedLimit), interactions: [] };
  if (boundedLimit === 1) {
    return { navigation: balancedNavigation(links, 1), interactions: [] };
  }

  const interactionQuota = Math.min(
    interactions.length,
    Math.max(1, Math.min(3, Math.floor(boundedLimit * 0.34))),
  );
  const navigationQuota = Math.min(links.length, Math.max(1, boundedLimit - interactionQuota));

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
