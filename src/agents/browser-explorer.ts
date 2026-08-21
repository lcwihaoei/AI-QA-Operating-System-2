import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import type { BrowserStorageState } from '../core/browser-state.js';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import type { ExplorationCandidate, QaEvent, QaRunOptions } from '../core/types.js';
import { clickabilityPreflight } from '../planning/clickability-preflight.js';
import { CoverageGraph } from '../planning/coverage-graph.js';
import { selectExplorationPlans } from '../planning/exploration-selection.js';
import { captureInteractionStateFingerprint } from '../planning/interaction-state-fingerprint.js';
import { PageStateAnalyzer } from '../planning/page-state-analyzer.js';
import { QaPlanner } from '../planning/qa-planner.js';
import { SyntheticInputStrategy } from '../planning/synthetic-input-strategy.js';
import { captureUxPageSnapshot } from '../ux/ux-page-snapshot.js';
import type { UxPageSnapshot } from '../ux/ux-types.js';

type QueueItem = {
  url: string;
  depth: number;
  source?: { pageUrl: string; candidateId: string };
  seed?: 'route-manifest';
};

export interface BrowserExplorationResult {
  events: QaEvent[];
  visitedUrls: string[];
  actions: number;
  storageState?: BrowserStorageState;
  uxSnapshots: UxPageSnapshot[];
}

export class BrowserExplorer {
  private static readonly candidateSelector = 'a[href], button, [role="button"], input:not([type="hidden"]), textarea, select';

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly planner: QaPlanner,
    private readonly coverage: CoverageGraph,
    private readonly inputStrategy: SyntheticInputStrategy = new SyntheticInputStrategy(),
    private readonly pageStateAnalyzer: PageStateAnalyzer = new PageStateAnalyzer(),
  ) {}

  async run(options: QaRunOptions): Promise<BrowserExplorationResult> {
    let browser: Browser | undefined;
    let storageState: BrowserStorageState | undefined;
    const events: QaEvent[] = [];
    const visited = new Set<string>();
    const queuedUrls = new Set<string>();
    const attemptedStateActions = new Set<string>();
    const uxSnapshots = new Map<string, UxPageSnapshot>();
    const startUrl = this.normalizeUrl(options.url);
    const origin = new URL(startUrl).origin;
    const routeSeeds = [...new Set(
      (options.routeSeeds ?? [])
        .slice(0, 200)
        .map((seed) => this.normalizeNavigableUrl(seed, startUrl))
        .filter((seed): seed is string => Boolean(seed))
        .filter((seed) => seed !== startUrl)
        .filter((seed) => !options.sameOriginOnly || new URL(seed).origin === origin),
    )];
    const queued: QueueItem[] = [
      { url: startUrl, depth: 0 },
      ...routeSeeds.map((url) => ({ url, depth: 0, seed: 'route-manifest' as const })),
    ];
    queuedUrls.add(startUrl);
    for (const seed of routeSeeds) queuedUrls.add(seed);
    let actions = 0;

    this.coverage.discoverPage(startUrl, 0);
    for (const seed of routeSeeds) this.coverage.discoverPage(seed, 0);
    if (routeSeeds.length > 0) {
      events.push(this.event('planner', startUrl, `Seeded ${routeSeeds.length} explicit route(s) from manifest`, {
        routeManifest: true,
        seededRoutes: routeSeeds.length,
      }));
    }

    try {
      browser = await chromium.launch({ headless: options.headless });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        recordHar: { path: `${this.evidence.runDir}/network.har`, mode: 'minimal' },
      });
      const page = await context.newPage();
      this.attachObservers(page, events);

      while (queued.length && actions < options.maxActions) {
        const item = queued.shift()!;
        queuedUrls.delete(item.url);
        if (visited.has(item.url) || item.depth > options.maxDepth) continue;
        if (options.sameOriginOnly && new URL(item.url).origin !== origin) continue;

        const response = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((error: unknown) => {
          events.push(this.event('page-error', item.url, `Navigation failed: ${String(error)}`));
          return null;
        });
        actions += 1;

        const actualUrl = this.normalizeUrl(page.url() || item.url);
        visited.add(item.url);
        visited.add(actualUrl);
        this.coverage.visitPage(actualUrl, item.depth);
        if (item.source && response) this.coverage.markCandidateExercised(item.source.pageUrl, item.source.candidateId);
        if (!response || response.status() >= 400) this.coverage.markPageError(actualUrl);

        events.push(this.event('action', actualUrl, `Navigate to ${item.url}`, {
          status: response?.status(),
          depth: item.depth,
          routeManifestSeed: item.seed === 'route-manifest',
        }));
        await page.waitForTimeout(180);
        await this.detectUiSignals(page, events);
        const shot = await this.evidence.screenshot(page, `page-${visited.size}`);
        events.push(this.event('snapshot', actualUrl, 'Captured page snapshot', { screenshot: shot }));

        try {
          const uxSnapshot = await captureUxPageSnapshot(page, actualUrl);
          uxSnapshots.set(uxSnapshot.urlPath, uxSnapshot);
        } catch (error: unknown) {
          events.push(this.event('snapshot', actualUrl, 'UX aggregate snapshot could not be captured during browser exploration', {
            uxSnapshot: true,
            success: false,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }));
        }

        const maxInteractionRounds = Math.max(1, Math.min(12, options.maxCandidatesPerPage));
        let interactionRound = 0;
        let shouldReplan = true;

        while (shouldReplan && actions < options.maxActions && interactionRound < maxInteractionRounds) {
          interactionRound += 1;
          shouldReplan = false;

          const candidates = await this.collectCandidates(page);
          const interactionStateId = await this.interactionStateId(page, actualUrl);
          const pageState = await this.pageStateAnalyzer.analyze(page);
          const ranking = await this.planner.rank(actualUrl, item.depth, candidates, options.riskMode, pageState, interactionStateId);
          const plans = ranking.plans;
          const allowedPlans = plans.filter((plan) => plan.decision.allowed);
          const blockedPlans = plans.filter((plan) => !plan.decision.allowed);
          const duplicateStatePlans = plans.filter((plan) =>
            plan.candidate.kind !== 'link'
            && !this.coverage.wasCandidateExercised(actualUrl, plan.candidate.id)
            && attemptedStateActions.has(stateActionKey(actualUrl, interactionStateId, plan.candidate.id)));
          const selectablePlans = plans.filter((plan) =>
            plan.candidate.kind === 'link'
            || (!this.coverage.wasCandidateExercised(actualUrl, plan.candidate.id)
              && !attemptedStateActions.has(stateActionKey(actualUrl, interactionStateId, plan.candidate.id))));
          const selected = selectExplorationPlans(selectablePlans, options.maxCandidatesPerPage);

          for (const plan of duplicateStatePlans) {
            if (!this.coverage.candidateTerminalReason(actualUrl, plan.candidate.id)) {
              this.coverage.markCandidateTerminal(actualUrl, plan.candidate.id, 'duplicate-state-action', 'same candidate was already attempted in the same structural page state');
            }
          }

          events.push(this.event('planner', actualUrl, `Planner ranked ${plans.length} candidates`, {
            interactionRound,
            interactionStateId,
            allowed: allowedPlans.length,
            blocked: blockedPlans.length,
            selectedNavigation: selected.navigation.length,
            selectedInteractions: selected.interactions.length,
            duplicateStateActionsSkipped: duplicateStatePlans.length,
            previouslyExercisedInteractions: plans.filter((plan) =>
              plan.candidate.kind !== 'link' && this.coverage.wasCandidateExercised(actualUrl, plan.candidate.id)).length,
            modelStatus: ranking.modelStatus,
            modelUsed: ranking.modelUsed,
            modelError: ranking.modelError,
            archetypes: pageState.archetypes,
            scenarios: ranking.scenarios.map((scenario) => ({ id: scenario.id, label: scenario.label, priority: scenario.priority })),
            pageSignals: {
              title: pageState.title,
              forms: pageState.formCount,
              fields: pageState.fieldCount,
              searchFields: pageState.searchFieldCount,
              dialogs: pageState.hasDialog,
              tables: pageState.hasTable,
            },
            top: allowedPlans.slice(0, 8).map((plan) => ({
              id: plan.candidate.id,
              label: plan.candidate.label,
              kind: plan.candidate.kind,
              score: plan.score,
              risk: plan.decision.risk,
              reasons: plan.decision.reasons,
            })),
            blockedExamples: blockedPlans.slice(0, 5).map((plan) => ({
              label: plan.candidate.label,
              kind: plan.candidate.kind,
              reasons: plan.decision.reasons,
            })),
          }));

          for (const plan of selected.navigation) {
            const candidate = plan.candidate;
            if (!candidate.href) continue;
            const next = this.normalizeNavigableUrl(candidate.href, actualUrl);
            if (!next) continue;
            if (options.sameOriginOnly && new URL(next).origin !== origin) continue;
            if (visited.has(next)) {
              this.coverage.markCandidateTerminal(actualUrl, candidate.id, 'navigation-duplicate', 'target route already covered');
              continue;
            }
            if (queuedUrls.has(next)) {
              this.coverage.markCandidateTerminal(actualUrl, candidate.id, 'navigation-duplicate', 'target route already queued');
              continue;
            }
            if (item.depth >= options.maxDepth) {
              this.coverage.markCandidateTerminal(actualUrl, candidate.id, 'budget-exhausted', 'navigation depth limit reached');
              continue;
            }
            this.coverage.discoverPage(next, item.depth + 1);
            queued.push({
              url: next,
              depth: item.depth + 1,
              source: { pageUrl: actualUrl, candidateId: candidate.id },
            });
            queuedUrls.add(next);
          }

          for (const plan of selected.interactions) {
            if (actions >= options.maxActions) break;
            const candidate = plan.candidate;
            attemptedStateActions.add(stateActionKey(actualUrl, interactionStateId, candidate.id));

            if (candidate.kind === 'field') {
              const exercised = await this.probeField(page, candidate, events, actions + 1);
              if (!exercised) continue;
              actions += 1;
              this.coverage.markCandidateExercised(actualUrl, candidate.id);
              await this.captureInteractionState(page, candidate, events, actions);
              const nextStateId = await this.interactionStateId(page, actualUrl);
              const materialStateChanged = nextStateId !== interactionStateId;
              if (materialStateChanged) this.markSiblingPlansInvalidated(actualUrl, selected.interactions, candidate.id);
              shouldReplan = true;
              events.push(this.event('planner', page.url(), 'Refreshed interaction frontier after field action', {
                stateReplan: true,
                materialStateChanged,
                candidateId: candidate.id,
                interactionRound,
                previousInteractionStateId: interactionStateId,
                nextInteractionStateId: nextStateId,
              }));
              break;
            }

            if (candidate.kind === 'button') {
              const outcome = await this.probeButton(page, candidate, events, actions + 1);
              if (!outcome.exercised) continue;
              actions += 1;
              this.coverage.markCandidateExercised(actualUrl, candidate.id);
              await this.captureInteractionState(page, candidate, events, actions);

              if (outcome.destination) {
                const destination = this.normalizeNavigableUrl(outcome.destination, actualUrl);
                if (destination && (!options.sameOriginOnly || new URL(destination).origin === origin)) {
                  this.coverage.discoverPage(destination, item.depth + 1);
                  if (!visited.has(destination) && !queuedUrls.has(destination) && item.depth < options.maxDepth) {
                    queued.push({ url: destination, depth: item.depth + 1 });
                    queuedUrls.add(destination);
                  }
                }
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5_000 }).catch(() => undefined);
                await page.waitForTimeout(120);
              }

              const nextStateId = await this.interactionStateId(page, actualUrl);
              const materialStateChanged = nextStateId !== interactionStateId;
              if (materialStateChanged) this.markSiblingPlansInvalidated(actualUrl, selected.interactions, candidate.id);
              shouldReplan = true;
              events.push(this.event('planner', page.url(), 'Refreshed interaction frontier after button action', {
                stateReplan: true,
                materialStateChanged,
                candidateId: candidate.id,
                interactionRound,
                navigated: Boolean(outcome.destination),
                previousInteractionStateId: interactionStateId,
                nextInteractionStateId: nextStateId,
              }));
              break;
            }
          }
        }

        if (shouldReplan && interactionRound >= maxInteractionRounds) {
          this.coverage.markRemainingEligibleTerminal('budget-exhausted', actualUrl, 'per-page interaction-round budget reached');
          events.push(this.event('planner', actualUrl, 'Stopped state replanning at the per-page interaction-round budget', {
            terminalGap: true,
            gapReason: 'budget-exhausted',
            gapDetail: 'per-page interaction-round budget reached',
            interactionRounds: interactionRound,
            maxInteractionRounds,
          }));
        }
      }

      if (actions >= options.maxActions) {
        this.coverage.markRemainingEligibleTerminal('budget-exhausted', undefined, 'global action budget reached');
        events.push(this.event('planner', explorationUrl(visited, startUrl), 'Stopped exploration at the global action budget', {
          terminalGap: true,
          gapReason: 'budget-exhausted',
          gapDetail: 'global action budget reached',
          actions,
          maxActions: options.maxActions,
        }));
      }

      storageState = await context.storageState().catch(() => undefined);
      await context.close();
    } finally {
      await browser?.close();
    }

    return { events, visitedUrls: [...visited], actions, storageState, uxSnapshots: [...uxSnapshots.values()] };
  }

  private async interactionStateId(page: Page, url: string): Promise<string> {
    return captureInteractionStateFingerprint(page).catch(() => `state-unavailable:${safePath(url)}`);
  }

  private markSiblingPlansInvalidated(url: string, plans: Array<{ candidate: ExplorationCandidate }>, exercisedId: string): void {
    for (const plan of plans) {
      if (plan.candidate.id === exercisedId) continue;
      this.coverage.markCandidateTerminal(url, plan.candidate.id, 'stale-after-state-change', 'remaining plan invalidated after a material UI state transition');
    }
  }

  private attachObservers(page: Page, events: QaEvent[]): void {
    page.on('console', (message) => {
      if (message.type() === 'error') events.push(this.event('console', page.url(), message.text()));
    });
    page.on('pageerror', (error) => {
      this.coverage.markPageError(this.normalizeUrl(page.url()));
      events.push(this.event('page-error', page.url(), error.message));
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        events.push(this.event('network', response.url(), `${response.request().method()} ${response.status()} ${response.url()}`, {
          status: response.status(),
          method: response.request().method(),
          resourceType: response.request().resourceType(),
        }));
      }
    });
  }

  private async collectCandidates(page: Page): Promise<ExplorationCandidate[]> {
    return page.locator(BrowserExplorer.candidateSelector).evaluateAll((elements) => {
      const occurrences = new Map<string, number>();
      return elements.slice(0, 160).map((element, locatorIndex) => {
        const node = element as HTMLElement;
        const tagName = node.tagName.toLowerCase();
        const formControl = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const associatedLabel = 'labels' in formControl
          ? Array.from(formControl.labels ?? []).map((label) => label.innerText.trim()).filter(Boolean).join(' ')
          : '';
        const label = (
          associatedLabel || node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') ||
          node.getAttribute('name') || node.getAttribute('title') || ''
        ).trim().replace(/\s+/g, ' ').slice(0, 120);
        const href = tagName === 'a' ? (node as HTMLAnchorElement).href : undefined;
        const button = tagName === 'button' ? (node as HTMLButtonElement) : undefined;
        const type = tagName === 'input'
          ? ((node as HTMLInputElement).type || 'text')
          : button
            ? (button.getAttribute('type') || (button.form ? 'submit' : 'button'))
            : tagName === 'select'
              ? 'select'
              : tagName === 'textarea'
                ? 'textarea'
                : undefined;
        const formAction = button?.form?.action || ('form' in formControl ? formControl.form?.action : undefined);
        const kind = tagName === 'a' ? 'link' as const : ['input', 'textarea', 'select'].includes(tagName) ? 'field' as const : 'button' as const;
        let hrefIdentity: string | undefined;
        if (href) {
          try {
            const parsed = new URL(href);
            hrefIdentity = parsed.pathname;
          } catch {
            hrefIdentity = href.split(/[?#]/, 1)[0];
          }
        }
        const identity = node.id
          ? `id=${node.id}`
          : node.getAttribute('name')
            ? `name=${node.getAttribute('name')}`
            : node.getAttribute('aria-label')
              ? `aria=${node.getAttribute('aria-label')}`
              : hrefIdentity
                ? `href=${hrefIdentity}`
                : `label=${label || tagName}`;
        const stableBase = `${kind}:${tagName}:${identity.replace(/\s+/g, ' ').slice(0, 180)}`;
        const occurrence = occurrences.get(stableBase) ?? 0;
        occurrences.set(stableBase, occurrence + 1);
        return {
          id: `${stableBase}:occurrence=${occurrence}`,
          kind,
          label,
          href,
          locatorIndex,
          tagName,
          role: node.getAttribute('role') || undefined,
          type,
          formAction,
          name: node.getAttribute('name') || undefined,
          placeholder: node.getAttribute('placeholder') || undefined,
          autocomplete: node.getAttribute('autocomplete') || undefined,
        };
      });
    });
  }

  private async probeField(page: Page, candidate: ExplorationCandidate, events: QaEvent[], actionNumber: number): Promise<boolean> {
    const locator = this.candidateLocator(page, candidate);
    if (!(await this.candidateStillMatches(locator, candidate)) || !(await locator.isVisible().catch(() => false)) || !(await locator.isEnabled().catch(() => false))) {
      this.coverage.markCandidateTerminal(this.normalizeUrl(page.url()), candidate.id, 'stale-after-state-change', 'candidate is no longer visible/enabled or no longer matches the current locator occupant');
      events.push(this.event('action', page.url(), `Skip stale/unavailable field candidate: ${candidate.label || candidate.id}`, {
        candidateId: candidate.id,
        staleCandidate: true,
        terminalGap: true,
        gapReason: 'stale-after-state-change',
      }));
      return false;
    }

    const strategy = this.inputStrategy.plan(candidate);
    if (strategy.action === 'skip') {
      this.coverage.markCandidateTerminal(this.normalizeUrl(page.url()), candidate.id, 'unsupported-control', strategy.reason);
      events.push(this.event('action', page.url(), `Skip unsupported field: ${candidate.label || candidate.id}`, {
        candidateId: candidate.id,
        reason: strategy.reason,
        terminalGap: true,
        gapReason: 'unsupported-control',
      }));
      return false;
    }

    events.push(this.event('action', page.url(), `Exercise field: ${candidate.label || candidate.name || candidate.id}`, {
      candidateId: candidate.id,
      actionNumber,
      strategy: strategy.action,
      synthetic: true,
      reason: strategy.reason,
    }));

    if (strategy.action === 'fill') {
      const filled = await locator.fill(strategy.value, { timeout: 3_000 }).then(() => true).catch((error: unknown) => {
        this.coverage.markCandidateTerminal(this.normalizeUrl(page.url()), candidate.id, 'execution-error', 'synthetic field fill failed');
        events.push(this.event('page-error', page.url(), `Synthetic field fill failed: ${String(error)}`, { candidateId: candidate.id }));
        return false;
      });
      if (!filled) return false;
    } else {
      const option = await locator.locator('option').evaluateAll((options) => {
        const available = options
          .map((option) => ({ value: (option as HTMLOptionElement).value, disabled: (option as HTMLOptionElement).disabled }))
          .filter((option) => !option.disabled && option.value);
        return available[1]?.value ?? available[0]?.value ?? null;
      }).catch(() => null);
      if (!option) {
        this.coverage.markCandidateTerminal(this.normalizeUrl(page.url()), candidate.id, 'unsupported-control', 'select has no safe enabled option');
        return false;
      }
      const selected = await locator.selectOption(option, { timeout: 3_000 }).then(() => true).catch((error: unknown) => {
        this.coverage.markCandidateTerminal(this.normalizeUrl(page.url()), candidate.id, 'execution-error', 'synthetic select failed');
        events.push(this.event('page-error', page.url(), `Synthetic select failed: ${String(error)}`, { candidateId: candidate.id }));
        return false;
      });
      if (!selected) return false;
    }

    await locator.blur().catch(() => undefined);
    await page.waitForTimeout(120);
    return true;
  }

  private async probeButton(
    page: Page,
    candidate: ExplorationCandidate,
    events: QaEvent[],
    actionNumber: number,
  ): Promise<{ exercised: boolean; destination?: string }> {
    const locator = this.candidateLocator(page, candidate);
    if (!(await this.candidateStillMatches(locator, candidate)) || !(await locator.isVisible().catch(() => false)) || !(await locator.isEnabled().catch(() => false))) {
      this.coverage.markCandidateTerminal(this.normalizeUrl(page.url()), candidate.id, 'stale-after-state-change', 'candidate is no longer visible/enabled or no longer matches the current locator occupant');
      events.push(this.event('action', page.url(), `Skip stale/unavailable button candidate: ${candidate.label || candidate.id}`, {
        candidateId: candidate.id,
        staleCandidate: true,
        terminalGap: true,
        gapReason: 'stale-after-state-change',
      }));
      return { exercised: false };
    }

    const before = this.normalizeUrl(page.url());
    const preflight = await clickabilityPreflight(locator);
    if (!preflight.clickable) {
      const reason = preflight.reason === 'pointer-intercepted'
        ? 'pointer-intercepted'
        : preflight.reason === 'not-rendered' || preflight.reason === 'outside-viewport'
          ? 'not-visible'
          : 'execution-error';
      this.coverage.markCandidateTerminal(before, candidate.id, reason, preflight.detail ?? preflight.reason);
      events.push(this.event('action', before, `Skip ${reason} button candidate: ${candidate.label || candidate.id}`, {
        candidateId: candidate.id,
        clickabilityPreflight: true,
        preflightReason: preflight.reason,
        preflightDetail: preflight.detail,
        terminalGap: true,
        gapReason: reason,
      }));
      return { exercised: false };
    }

    events.push(this.event('action', before, `Click button: ${candidate.label || 'unnamed-button'}`, {
      candidateId: candidate.id,
      actionNumber,
      clickabilityPreflight: true,
    }));

    const clicked = await locator.click({ timeout: 1_500 }).then(() => true).catch((error: unknown) => {
      const message = String(error);
      const intercepted = /intercept|receives pointer events/i.test(message);
      this.coverage.markCandidateTerminal(before, candidate.id, intercepted ? 'pointer-intercepted' : 'execution-error', intercepted ? 'click hit target was intercepted after preflight' : 'button probe failed after preflight');
      events.push(this.event('page-error', before, `Button probe failed: ${message}`, { candidateId: candidate.id, clickabilityPreflight: true }));
      return false;
    });
    if (!clicked) return { exercised: false };

    await page.waitForTimeout(180);
    const after = this.normalizeUrl(page.url());
    if (after !== before) {
      events.push(this.event('navigation', after, `Button navigation: ${candidate.label || candidate.id}`, { from: before }));
      return { exercised: true, destination: after };
    }
    return { exercised: true };
  }

  private candidateLocator(page: Page, candidate: ExplorationCandidate): Locator {
    return page.locator(BrowserExplorer.candidateSelector).nth(candidate.locatorIndex);
  }

  private async candidateStillMatches(locator: Locator, candidate: ExplorationCandidate): Promise<boolean> {
    return locator.evaluate((element, expected) => {
      const node = element as HTMLElement;
      if (node.tagName.toLowerCase() !== expected.tagName) return false;
      if (expected.name && node.getAttribute('name') !== expected.name) return false;
      if (expected.href && node instanceof HTMLAnchorElement && node.href !== expected.href) return false;
      const formControl = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const associatedLabel = 'labels' in formControl
        ? Array.from(formControl.labels ?? []).map((label) => label.innerText.trim()).filter(Boolean).join(' ')
        : '';
      const currentLabel = (
        associatedLabel || node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('name') || node.getAttribute('title') || ''
      ).trim().replace(/\s+/g, ' ').slice(0, 120);
      if (expected.label && currentLabel && currentLabel !== expected.label) return false;
      return true;
    }, {
      tagName: candidate.tagName,
      name: candidate.name,
      href: candidate.href,
      label: candidate.label,
    }).catch(() => false);
  }

  private async captureInteractionState(page: Page, candidate: ExplorationCandidate, events: QaEvent[], actionNumber: number): Promise<void> {
    await this.detectUiSignals(page, events);
    const interactionShot = await this.evidence.screenshot(page, `interaction-${actionNumber}`);
    events.push(this.event('snapshot', page.url(), `Captured state after ${candidate.label || candidate.kind} interaction`, {
      screenshot: interactionShot,
      candidateId: candidate.id,
      candidateKind: candidate.kind,
    }));
  }

  private async detectUiSignals(page: Page, events: QaEvent[]): Promise<void> {
    const signals = await page.evaluate(() => {
      type BrowserUiSignal = { uiKind: 'horizontal-overflow' | 'interactive-offscreen'; message: string; element?: string };
      const problems: BrowserUiSignal[] = [];
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth + 4) {
        problems.push({
          uiKind: 'horizontal-overflow',
          message: `Horizontal overflow: scrollWidth=${root.scrollWidth}, clientWidth=${root.clientWidth}`,
        });
      }

      const describe = (element: Element): string => {
        const node = element as HTMLElement;
        const id = node.id ? `#${node.id}` : '';
        const classes = typeof node.className === 'string'
          ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((value) => `.${value}`).join('')
          : '';
        const label = (node.getAttribute('aria-label') || node.getAttribute('name') || node.textContent || '')
          .replace(/\s+/g, ' ').trim().slice(0, 80);
        return `${node.tagName.toLowerCase()}${id}${classes}${label ? ` "${label}"` : ''}`.slice(0, 180);
      };

      const isWithinCollapsedControlledRegion = (element: Element): boolean => {
        const rect = (element as HTMLElement).getBoundingClientRect();
        const horizontallyDisplaced = rect.right <= 0 || rect.left >= window.innerWidth;
        if (!horizontallyDisplaced) return false;
        const controls = Array.from(document.querySelectorAll<HTMLElement>('[aria-controls][aria-expanded="false"]'));
        for (const control of controls) {
          const controlledId = control.getAttribute('aria-controls');
          if (!controlledId) continue;
          const region = document.getElementById(controlledId);
          if (region && (region === element || region.contains(element))) return true;
        }
        return false;
      };

      const intentionallySuppressed = (element: Element): boolean => {
        if (element.closest('[hidden],[inert],[aria-hidden="true"],[data-state="closed"],[data-open="false"]')) return true;
        let current: Element | null = element;
        for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
          const style = getComputedStyle(current as HTMLElement);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity || '1') <= 0.01) return true;
        }
        return isWithinCollapsedControlledRegion(element);
      };

      for (const el of Array.from(document.querySelectorAll('button, a[href], input, textarea, select')).slice(0, 250)) {
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || intentionallySuppressed(el)) continue;
        const entirelyOutside = rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight;
        if (!entirelyOutside) continue;
        const element = describe(el);
        problems.push({
          uiKind: 'interactive-offscreen',
          element,
          message: `Interactive element rendered entirely outside viewport: ${element}`,
        });
      }
      return problems.slice(0, 20);
    });
    for (const signal of signals) {
      events.push(this.event('ui', page.url(), signal.message, {
        browserUi: true,
        uiKind: signal.uiKind,
        element: signal.element,
      }));
    }
  }

  private normalizeNavigableUrl(value: string, base: string): string | null {
    try {
      const url = new URL(value, base);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  private normalizeUrl(value: string): string {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.toString();
    } catch {
      return value;
    }
  }

  private event(kind: QaEvent['kind'], url: string, message: string, details?: Record<string, unknown>): QaEvent {
    return { timestamp: new Date().toISOString(), kind, url, message, details };
  }
}

function stateActionKey(url: string, stateId: string, candidateId: string): string {
  return `${safePath(url)}|${stateId}|${candidateId}`;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url.split(/[?#]/, 1)[0] || '/';
  }
}

function explorationUrl(visited: Set<string>, fallback: string): string {
  return [...visited].at(-1) ?? fallback;
}
