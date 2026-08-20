import { createHash } from 'node:crypto';
import type { QaEvent } from '../core/types.js';
import type { UxFlowSnapshot, UxImpact, UxOpportunity, UxOpportunityCategory, UxPageSnapshot } from './ux-types.js';

function id(category: UxOpportunityCategory, metric: string): string {
  return createHash('sha1').update(`${category}|${metric}`).digest('hex').slice(0, 14);
}

function opportunity(
  category: UxOpportunityCategory,
  impact: UxImpact,
  confidence: number,
  title: string,
  observation: string,
  recommendation: string,
  expectedEffect: string,
  metric: string,
): UxOpportunity {
  return { id: id(category, metric), category, impact, confidence, title, observation, recommendation, expectedEffect, metric, source: 'deterministic' };
}

export function buildUxFlowSnapshot(events: QaEvent[]): UxFlowSnapshot {
  const actions = events.filter((event) => event.kind === 'action');
  const counts = new Map<string, number>();
  let backtracks = 0;
  for (const event of actions) {
    const key = event.message.toLowerCase().replace(/\d+/g, '#').slice(0, 200);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (/\b(back|previous|go back)\b|返回|上一頁|上一步/i.test(event.message)) backtracks += 1;
  }
  const repeatedActions = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const errors = events.filter((event) => ['page-error', 'network', 'console', 'assertion'].includes(event.kind)).length;
  return { actions: actions.length, repeatedActions, backtracks, errors };
}

export function analyzeUx(pages: UxPageSnapshot[], flow: UxFlowSnapshot): UxOpportunity[] {
  const result: UxOpportunity[] = [];
  if (pages.length === 0) return result;
  const maxInteractive = Math.max(...pages.map((page) => page.interactiveCount));
  const maxFields = Math.max(...pages.map((page) => page.formFieldCount));
  const unlabeled = pages.reduce((sum, page) => sum + page.unlabeledInteractiveCount, 0);
  const deepRoutes = pages.filter((page) => page.routeDepth >= 5).length;
  const longSparsePages = pages.filter((page) => page.scrollRatio >= 5 && page.headings <= 2).length;
  const noHierarchy = pages.filter((page) => page.h1Count === 0 || !page.hasMeaningfulTitle).length;
  const ambiguous = pages.reduce((sum, page) => sum + page.ambiguousActionCount, 0);
  const formWithoutPrimary = pages.filter((page) => page.formFieldCount > 0 && page.primaryActionKinds.length === 0).length;
  const competingPrimary = pages.filter((page) => page.primaryActionKinds.length >= 4).length;

  if (unlabeled > 0) result.push(opportunity(
    'accessibility', unlabeled >= 4 ? 'high' : 'medium', 0.98,
    'Interactive controls lack a discoverable accessible name',
    `${unlabeled} interactive controls were observed without a usable text/ARIA/name signal.`,
    'Give every actionable control a concise accessible name that matches its visible purpose.',
    'Improves keyboard/screen-reader usability and reduces ambiguous controls for all users.', `unlabeled:${unlabeled}`,
  ));
  if (maxInteractive >= 35 || maxFields >= 12) result.push(opportunity(
    'cognitive-load', maxInteractive >= 55 || maxFields >= 18 ? 'high' : 'medium', 0.88,
    'One or more screens present too many simultaneous choices',
    `Peak screen density was ${maxInteractive} interactive controls and ${maxFields} form fields.`,
    'Group advanced actions behind progressive disclosure and keep the primary task visually dominant.',
    'Reduces scanning and decision cost before the user can identify the next action.', `density:${maxInteractive}:${maxFields}`,
  ));
  if (formWithoutPrimary > 0) result.push(opportunity(
    'discoverability', 'high', 0.9,
    'Forms do not expose a recognizable completion action',
    `${formWithoutPrimary} form-oriented pages had fields but no recognizable primary completion action.`,
    'Provide one clearly labeled primary CTA near the end of the form and keep secondary actions visually subordinate.',
    'Makes task completion easier to discover and lowers abandonment.', `form-no-primary:${formWithoutPrimary}`,
  ));
  if (competingPrimary > 0) result.push(opportunity(
    'cognitive-load', 'medium', 0.82,
    'Multiple competing primary actions weaken hierarchy',
    `${competingPrimary} pages exposed four or more primary-action categories at once.`,
    'Choose one primary action for the current user goal and demote alternatives to secondary/overflow actions.',
    'Improves visual hierarchy and reduces choice paralysis.', `competing-primary:${competingPrimary}`,
  ));
  if (deepRoutes > 0) result.push(opportunity(
    'information-architecture', deepRoutes >= 3 ? 'high' : 'medium', 0.8,
    'Important content may be buried too deeply in the navigation hierarchy',
    `${deepRoutes} visited routes were at least five path segments deep.`,
    'Promote frequently used tasks, add contextual shortcuts, or flatten intermediate navigation levels.',
    'Reduces navigation depth and time-to-feature.', `deep-routes:${deepRoutes}`,
  ));
  if (longSparsePages > 0) result.push(opportunity(
    'information-architecture', 'medium', 0.78,
    'Long pages have insufficient information landmarks',
    `${longSparsePages} pages exceeded five viewport heights while exposing at most two headings.`,
    'Introduce meaningful section headings, sticky local navigation, or split distinct tasks into focused sections.',
    'Improves orientation and makes long content scannable.', `long-sparse:${longSparsePages}`,
  ));
  if (noHierarchy > 0) result.push(opportunity(
    'first-time-experience', noHierarchy === pages.length ? 'high' : 'medium', 0.84,
    'Page purpose is not consistently obvious to a first-time user',
    `${noHierarchy} pages lacked a strong H1/title hierarchy signal.`,
    'Use a descriptive page title and one clear top-level heading that states the current task or outcome.',
    'Helps new users understand where they are and what they can accomplish.', `hierarchy:${noHierarchy}:${pages.length}`,
  ));
  if (ambiguous >= 3) result.push(opportunity(
    'discoverability', 'medium', 0.86,
    'Generic action labels reduce predictability',
    `${ambiguous} controls used generic labels such as More/Open/Here.`,
    'Name actions by outcome, for example “View device logs” instead of “Open”.',
    'Makes choices understandable before users commit to an action.', `ambiguous:${ambiguous}`,
  ));
  if (flow.backtracks >= 2 || flow.repeatedActions >= 3) result.push(opportunity(
    'efficiency', flow.backtracks >= 4 ? 'high' : 'medium', 0.8,
    'Observed exploration contains avoidable backtracking or repeated actions',
    `The flow contained ${flow.backtracks} backtracks and ${flow.repeatedActions} repeated actions.`,
    'Add direct contextual shortcuts and keep the next likely action near the state that creates the need for it.',
    'Reduces task steps and navigation recovery work.', `flow:${flow.backtracks}:${flow.repeatedActions}`,
  ));

  const mutationKinds = new Set(pages.flatMap((page) => page.primaryActionKinds).filter((kind) => ['save', 'apply', 'update', 'confirm'].includes(kind)));
  if (mutationKinds.size >= 3) result.push(opportunity(
    'consistency', 'medium', 0.76,
    'Equivalent completion actions use inconsistent terminology',
    `Observed ${mutationKinds.size} different completion verbs across the visited product surface.`,
    'Standardize equivalent actions around one product vocabulary and reserve different verbs for genuinely different outcomes.',
    'Improves learnability and lowers semantic uncertainty.', `mutation-vocabulary:${[...mutationKinds].sort().join(',')}`,
  ));

  return result;
}

export function scoreUx(opportunities: UxOpportunity[]): number {
  const weight: Record<UxImpact, number> = { high: 14, medium: 8, low: 4 };
  const penalty = opportunities.reduce((sum, item) => sum + weight[item.impact] * Math.max(0.4, Math.min(item.confidence, 1)), 0);
  return Math.max(0, Math.round((100 - Math.min(100, penalty)) * 10) / 10);
}
