import { chromium, type Browser, type BrowserContextOptions } from '@playwright/test';
import type { BrowserStorageState } from '../core/browser-state.js';
import type { QaEvent } from '../core/types.js';
import { analyzeUx, buildUxFlowSnapshot, scoreUx } from '../ux/ux-heuristics.js';
import { captureUxPageSnapshot, uxPathInfo } from '../ux/ux-page-snapshot.js';
import type { UxAgentResult, UxOpportunity, UxPageSnapshot, UxReasoner } from '../ux/ux-types.js';

const MAX_PAGES = 50;

function mergeReasoner(base: UxOpportunity[], additions: Array<Omit<UxOpportunity, 'id' | 'source'>>): UxOpportunity[] {
  const result = [...base];
  let index = 0;
  for (const addition of additions.slice(0, 20)) {
    if (addition.confidence < 0.6) continue;
    result.push({ ...addition, id: `reasoner-${++index}`, source: 'reasoner' });
  }
  return result;
}

function safeFailure(target: string, error: unknown): string {
  const path = uxPathInfo(target).urlPath;
  const kind = error instanceof Error ? error.name : 'UnknownError';
  return `${path}: ${kind}`.slice(0, 240);
}

export function uxBaselineEligible(summary: UxAgentResult['summary']): boolean {
  return summary.valid && summary.pagesAnalyzed > 0 && summary.completeness >= 0.8;
}

export class UxAgent {
  constructor(private readonly storageState?: BrowserStorageState, private readonly reasoner?: UxReasoner) {}

  async run(urls: string[], events: QaEvent[], seedSnapshots: UxPageSnapshot[] = []): Promise<UxAgentResult> {
    const flow = buildUxFlowSnapshot(events);
    const unique = [...new Map(urls.map((target) => [uxPathInfo(target).urlPath, target])).values()].slice(0, MAX_PAGES);
    const snapshotsByPath = new Map<string, UxPageSnapshot>();
    for (const snapshot of seedSnapshots) snapshotsByPath.set(snapshot.urlPath, snapshot);
    const failures: string[] = [];
    let browser: Browser | undefined;

    const missing = unique.filter((target) => !snapshotsByPath.has(uxPathInfo(target).urlPath));
    if (missing.length > 0) {
      try {
        browser = await chromium.launch({ headless: true });
        const contextOptions: BrowserContextOptions = { viewport: { width: 1440, height: 1000 } };
        if (this.storageState) contextOptions.storageState = this.storageState;
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        for (const target of missing) {
          try {
            const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
            if (!response || response.status() >= 400) throw new Error('UxNavigationError');
            await page.locator('body').waitFor({ state: 'attached', timeout: 3_000 });
            await page.waitForTimeout(120);
            const snapshot = await captureUxPageSnapshot(page, target);
            snapshotsByPath.set(snapshot.urlPath, snapshot);
          } catch (error: unknown) {
            failures.push(safeFailure(target, error));
          }
        }
        await context.close();
      } catch (error: unknown) {
        for (const target of missing) {
          const path = uxPathInfo(target).urlPath;
          if (!snapshotsByPath.has(path) && !failures.some((item) => item.startsWith(`${path}:`))) {
            failures.push(safeFailure(target, error));
          }
        }
      } finally {
        await browser?.close().catch(() => undefined);
      }
    }

    const requestedPaths = new Set(unique.map((target) => uxPathInfo(target).urlPath));
    const snapshots = [...snapshotsByPath.values()].filter((snapshot) => requestedPaths.has(snapshot.urlPath));
    let opportunities = analyzeUx(snapshots, flow);
    let reasonerUsed = false;
    if (this.reasoner && snapshots.length > 0) {
      try {
        const proposed = await this.reasoner.propose({ pages: snapshots, flow, deterministic: opportunities });
        opportunities = mergeReasoner(opportunities, proposed);
        reasonerUsed = true;
      } catch {
        reasonerUsed = false;
      }
    }

    const pagesAttempted = unique.length;
    const pagesAnalyzed = snapshots.length;
    const pagesFailed = Math.max(0, pagesAttempted - pagesAnalyzed);
    const completeness = pagesAttempted === 0 ? 1 : Math.round((pagesAnalyzed / pagesAttempted) * 1000) / 1000;
    const valid = pagesAnalyzed > 0;
    const toolingError = pagesFailed > 0
      ? `UX snapshot collection incomplete: ${pagesFailed}/${pagesAttempted} pages failed${failures.length ? ` (${failures.slice(0, 5).join(', ')})` : ''}`
      : undefined;

    const summary = {
      enabled: true,
      pagesAttempted,
      pagesAnalyzed,
      pagesFailed,
      completeness,
      valid,
      score: valid ? scoreUx(opportunities) : 0,
      opportunities: opportunities.length,
      highImpact: opportunities.filter((item) => item.impact === 'high').length,
      mediumImpact: opportunities.filter((item) => item.impact === 'medium').length,
      lowImpact: opportunities.filter((item) => item.impact === 'low').length,
      reasonerUsed,
      ...(toolingError ? { toolingError } : {}),
    };
    return { summary, opportunities, snapshots, flow };
  }
}
