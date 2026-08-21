import { chromium, type Browser, type BrowserContextOptions } from '@playwright/test';
import type { ReproductionStatus } from '../contracts/quality-contracts.js';
import type { BrowserStorageState } from '../core/browser-state.js';
import type { QaEvent, ReproductionSummary } from '../core/types.js';
import { VISUAL_VIEWPORTS } from '../agents/visual-agent.js';
import { DomGeometryAnalyzer, type VisualSignal, type VisualSignalKind } from '../visual/dom-geometry-analyzer.js';

const VISUAL_KINDS = new Set<VisualSignalKind>([
  'horizontal-overflow',
  'interactive-offscreen',
  'text-clipping',
  'interactive-overlap',
]);

interface ReproductionAttemptResult {
  status: ReproductionStatus;
  reason: string;
  matchedSignal?: VisualSignal;
}

export interface ReproductionAgentResult {
  events: QaEvent[];
  summary: ReproductionSummary;
}

function stringDetail(event: QaEvent, key: string): string | undefined {
  const value = event.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberDetail(event: QaEvent, key: string): number | undefined {
  const value = event.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function visualKind(event: QaEvent): VisualSignalKind | undefined {
  const value = stringDetail(event, 'visualKind');
  return value && VISUAL_KINDS.has(value as VisualSignalKind) ? value as VisualSignalKind : undefined;
}

function targetMatches(event: QaEvent, signal: VisualSignal): boolean {
  const expectedKind = visualKind(event);
  if (!expectedKind || signal.kind !== expectedKind) return false;

  const expectedElement = stringDetail(event, 'element');
  const expectedRelated = stringDetail(event, 'relatedElement');
  if (expectedElement && signal.element !== expectedElement) return false;
  if (expectedRelated && signal.relatedElement !== expectedRelated) return false;
  return true;
}

function viewportFor(event: QaEvent): { width: number; height: number } {
  const explicitWidth = numberDetail(event, 'viewportWidth');
  const explicitHeight = numberDetail(event, 'viewportHeight');
  if (explicitWidth && explicitHeight) return { width: explicitWidth, height: explicitHeight };

  const name = stringDetail(event, 'viewport');
  if (name === 'desktop' || name === 'tablet' || name === 'mobile') {
    return { width: VISUAL_VIEWPORTS[name].width, height: VISUAL_VIEWPORTS[name].height };
  }
  return { width: VISUAL_VIEWPORTS.desktop.width, height: VISUAL_VIEWPORTS.desktop.height };
}

function annotate(event: QaEvent, attempt: ReproductionAttemptResult): QaEvent {
  return {
    ...event,
    details: {
      ...(event.details ?? {}),
      independentReproduction: true,
      reproductionStatus: attempt.status,
      reproductionReason: attempt.reason,
      reproductionObservedAt: new Date().toISOString(),
      ...(attempt.matchedSignal ? {
        reproducedSignal: {
          kind: attempt.matchedSignal.kind,
          element: attempt.matchedSignal.element,
          relatedElement: attempt.matchedSignal.relatedElement,
          rect: attempt.matchedSignal.rect,
          relatedRect: attempt.matchedSignal.relatedRect,
        },
      } : {}),
    },
  };
}

export class ReproductionAgent {
  constructor(
    private readonly storageState?: BrowserStorageState,
    private readonly analyzer: DomGeometryAnalyzer = new DomGeometryAnalyzer(),
    private readonly maxAttempts = 40,
  ) {}

  async run(events: QaEvent[]): Promise<ReproductionAgentResult> {
    const eligibleIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.kind === 'ui' && event.details?.visual === true && Boolean(visualKind(event)));

    if (eligibleIndexes.length === 0) {
      return {
        events,
        summary: {
          enabled: true,
          eligible: 0,
          attempted: 0,
          confirmed: 0,
          notReproduced: 0,
          blocked: 0,
          notRun: 0,
          maxAttempts: this.maxAttempts,
        },
      };
    }

    const output = [...events];
    let browser: Browser | undefined;
    let attempted = 0;
    let confirmed = 0;
    let notReproduced = 0;
    let blocked = 0;
    let toolingError: string | undefined;

    try {
      browser = await chromium.launch({ headless: true });
      for (const { event, index } of eligibleIndexes.slice(0, this.maxAttempts)) {
        attempted += 1;
        const result = await this.attempt(browser, event);
        output[index] = annotate(event, result);
        if (result.status === 'confirmed') confirmed += 1;
        else if (result.status === 'not-reproduced') notReproduced += 1;
        else if (result.status === 'blocked') blocked += 1;
      }
    } catch (error: unknown) {
      toolingError = String(error);
    } finally {
      await browser?.close().catch(() => undefined);
    }

    const attemptedIndexes = new Set(eligibleIndexes.slice(0, attempted).map((item) => item.index));
    for (const { event, index } of eligibleIndexes) {
      if (attemptedIndexes.has(index)) continue;
      output[index] = annotate(event, {
        status: 'not-run',
        reason: toolingError
          ? `independent reproduction stopped because the reproduction runtime failed: ${toolingError}`
          : `independent reproduction attempt budget exhausted at ${this.maxAttempts} visual signals`,
      });
    }

    return {
      events: output,
      summary: {
        enabled: true,
        eligible: eligibleIndexes.length,
        attempted,
        confirmed,
        notReproduced,
        blocked,
        notRun: Math.max(0, eligibleIndexes.length - attempted),
        maxAttempts: this.maxAttempts,
        ...(toolingError ? { toolingError } : {}),
      },
    };
  }

  private async attempt(browser: Browser, event: QaEvent): Promise<ReproductionAttemptResult> {
    const viewport = viewportFor(event);
    const contextOptions: BrowserContextOptions = { viewport };
    if (this.storageState) contextOptions.storageState = this.storageState;
    const context = await browser.newContext(contextOptions);

    try {
      const page = await context.newPage();
      const response = await page.goto(event.url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => null);
      if (!response) {
        return { status: 'blocked', reason: 'fresh reproduction navigation failed before geometry could be observed' };
      }
      if (response.status() >= 400) {
        return { status: 'blocked', reason: `fresh reproduction navigation returned HTTP ${response.status()}` };
      }

      await page.waitForTimeout(180);
      const signals = await this.analyzer.analyze(page).catch(() => undefined);
      if (!signals) {
        return { status: 'blocked', reason: 'fresh reproduction geometry analysis failed' };
      }

      const matched = signals.find((signal) => targetMatches(event, signal));
      if (!matched) {
        return {
          status: 'not-reproduced',
          reason: 'a fresh browser context at the same viewport did not emit the same detector signal for the same element identity',
        };
      }

      return {
        status: 'confirmed',
        reason: 'a fresh browser context at the same viewport independently emitted the same detector signal for the same element identity',
        matchedSignal: matched,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  }
}
