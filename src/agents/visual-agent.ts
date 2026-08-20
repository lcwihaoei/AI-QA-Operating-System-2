import path from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import type { BrowserStorageState } from '../core/browser-state.js';
import type { QaEvent, VisualViewportName } from '../core/types.js';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import { DomGeometryAnalyzer } from '../visual/dom-geometry-analyzer.js';
import { fuseVisualEvidence } from '../visual/evidence-fusion.js';
import type { VisualEvidenceAssessment, VisualEvidenceProvider } from '../visual/visual-evidence-provider.js';

export interface VisualViewportProfile {
  name: VisualViewportName;
  width: number;
  height: number;
}

export const VISUAL_VIEWPORTS: Record<VisualViewportName, VisualViewportProfile> = {
  desktop: { name: 'desktop', width: 1440, height: 1000 },
  tablet: { name: 'tablet', width: 768, height: 1024 },
  mobile: { name: 'mobile', width: 390, height: 844 },
};

export function resolveVisualViewports(names: VisualViewportName[]): VisualViewportProfile[] {
  const unique = [...new Set(names)];
  return unique.map((name) => VISUAL_VIEWPORTS[name]);
}

export interface VisualAgentVideo {
  viewport: VisualViewportName;
  path: string;
}

export interface VisualAgentResult {
  events: QaEvent[];
  analyzedStates: number;
  videos: VisualAgentVideo[];
}

export class VisualAgent {
  constructor(
    private readonly evidence: EvidenceStore,
    private readonly analyzer: DomGeometryAnalyzer = new DomGeometryAnalyzer(),
    private readonly viewports: VisualViewportProfile[] = [VISUAL_VIEWPORTS.desktop, VISUAL_VIEWPORTS.mobile],
    private readonly storageState?: BrowserStorageState,
    private readonly evidenceProvider?: VisualEvidenceProvider,
    private readonly recordVideo = false,
  ) {}

  async run(urls: string[]): Promise<VisualAgentResult> {
    let browser: Browser | undefined;
    const events: QaEvent[] = [];
    const videos: VisualAgentVideo[] = [];
    let analyzedStates = 0;

    try {
      browser = await chromium.launch({ headless: true });
      for (const viewport of this.viewports) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          storageState: this.storageState,
          recordVideo: this.recordVideo
            ? { dir: path.join(this.evidence.runDir, 'videos'), size: { width: viewport.width, height: viewport.height } }
            : undefined,
        });
        const page = await context.newPage();
        const pageVideo = page.video();

        for (const url of [...new Set(urls)]) {
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((error: unknown) => {
            events.push(this.event('snapshot', url, `Visual navigation skipped: ${viewport.name}`, {
              visual: true,
              viewport: viewport.name,
              error: String(error),
            }));
            return null;
          });
          if (!response) continue;
          if (response.status() >= 400) {
            events.push(this.event('snapshot', page.url(), `Visual page returned HTTP ${response.status()}: ${viewport.name}`, {
              visual: true,
              viewport: viewport.name,
              status: response.status(),
            }));
            continue;
          }

          await page.waitForTimeout(150);
          const signals = await this.analyzer.analyze(page).catch((error: unknown) => {
            events.push(this.event('snapshot', page.url(), `DOM geometry analysis skipped: ${viewport.name}`, {
              visual: true,
              viewport: viewport.name,
              error: String(error),
              analysisSucceeded: false,
            }));
            return undefined;
          });
          if (!signals) continue;
          analyzedStates += 1;

          let screenshot: string | undefined;
          if (signals.length > 0) {
            screenshot = await this.evidence.screenshot(page, `visual-${viewport.name}-${analyzedStates}`, false);
          }

          let providerError: string | undefined;
          let assessments: VisualEvidenceAssessment[] = [];
          if (signals.length > 0 && screenshot && this.evidenceProvider) {
            try {
              assessments = await this.evidenceProvider.assess({
                url: page.url(),
                viewport,
                screenshotPath: screenshot,
                signals,
              });
            } catch (error: unknown) {
              providerError = String(error);
            }
          }
          const fused = fuseVisualEvidence(signals, assessments);

          events.push(this.event('snapshot', page.url(), `Visual geometry pass: ${viewport.name}`, {
            visual: true,
            viewport: viewport.name,
            width: viewport.width,
            height: viewport.height,
            signalCount: signals.length,
            screenshot,
            analysisSucceeded: true,
            sessionStateReused: Boolean(this.storageState),
            evidenceProviderUsed: Boolean(this.evidenceProvider && screenshot),
            evidenceProviderError: providerError,
          }));

          for (const item of fused) {
            const signal = item.signal;
            events.push(this.event(
              'ui',
              page.url(),
              `${signal.message} [viewport=${viewport.name} ${viewport.width}x${viewport.height}]`,
              {
                visual: true,
                viewport: viewport.name,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                visualKind: signal.kind,
                severityHint: item.severity,
                element: signal.element,
                relatedElement: signal.relatedElement,
                rect: signal.rect,
                relatedRect: signal.relatedRect,
                screenshot,
                sessionStateReused: Boolean(this.storageState),
                evidenceVerdict: item.assessment?.verdict,
                evidenceConfidence: item.assessment?.confidence,
                evidenceReason: item.assessment?.reason,
                ...signal.details,
              },
            ));
          }
        }

        await context.close();
        if (this.recordVideo && pageVideo) {
          const videoPath = await pageVideo.path().catch(() => undefined);
          if (videoPath) {
            videos.push({ viewport: viewport.name, path: videoPath });
            events.push(this.event('snapshot', urls[0] ?? 'about:blank', `Recorded visual QA video: ${viewport.name}`, {
              visualVideo: true,
              viewport: viewport.name,
              video: videoPath,
            }));
          }
        }
      }
    } finally {
      await browser?.close();
    }

    return { events, analyzedStates, videos };
  }

  private event(kind: QaEvent['kind'], url: string, message: string, details?: Record<string, unknown>): QaEvent {
    return { timestamp: new Date().toISOString(), kind, url, message, details };
  }
}
