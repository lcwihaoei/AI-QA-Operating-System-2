import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QaRunResult } from '../src/core/types.js';
import { generateEvidenceReport } from '../src/reporting/evidence-report.js';
import type { UxOpportunity } from '../src/ux/ux-types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ runDir: string; screenshot: string; video: string }> {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'aiqa-report-'));
  dirs.push(runDir);
  await mkdir(path.join(runDir, 'screenshots'), { recursive: true });
  await mkdir(path.join(runDir, 'videos'), { recursive: true });
  const screenshot = path.join(runDir, 'screenshots', 'finding.png');
  const video = path.join(runDir, 'videos', 'tablet.webm');
  await writeFile(screenshot, 'png-placeholder');
  await writeFile(video, 'webm-placeholder');
  return { runDir, screenshot, video };
}

function result(runDir: string, screenshot: string): QaRunResult {
  return {
    runId: 'beta7-report-test',
    startedAt: '2026-08-20T00:00:00.000Z',
    finishedAt: '2026-08-20T00:00:10.000Z',
    visitedUrls: ['https://example.com/settings'],
    actions: 4,
    events: [{
      timestamp: '2026-08-20T00:00:05.000Z',
      kind: 'ui',
      url: 'https://example.com/settings',
      message: 'Visible text appears clipped: span "<script>alert(1)</script>" [viewport=tablet 768x1024]',
      details: {
        visual: true,
        visualKind: 'text-clipping',
        viewport: 'tablet',
        viewportWidth: 768,
        viewportHeight: 1024,
        baselineState: 'new',
        screenshot,
        element: 'span.settings-label',
        rect: { x: 24, y: 40, width: 220, height: 32 },
      },
    }],
    findings: [{
      id: 'BUG-0001',
      kind: 'ui',
      severity: 'medium',
      title: 'Visible text is clipped',
      url: 'https://example.com/settings',
      message: 'Visible text appears clipped: span "<script>alert(1)</script>" [viewport=tablet 768x1024]',
      reproduction: ['Open settings', 'Observe the label'],
      evidence: [screenshot],
      fingerprint: 'abc123',
    }],
    coverage: { score: 73, pageCoverage: 100, interactionCoverage: 40, pages: [], gaps: [] },
    visualBaseline: { enabled: true, existed: true, newSignals: 1, persistentSignals: 2, resolvedSignals: 3, updated: false },
    api: { enabled: false, mode: 'off', operationsDiscovered: 0, operationsTested: 0, operationsSkipped: 0 },
    correlation: { chains: 0, highConfidence: 0, apiMatched: 0, browserNetworkFailures: 0 },
    semanticState: { enabled: false, apiFactsObserved: 0, uiFieldsObserved: 0, comparisons: 0, matches: 0, mismatches: 0, ambiguousSkipped: 0 },
    device: {
      enabled: false, mode: 'off', sessionStarted: false, screenshotCaptured: false, pageSourceChars: 0, elementEstimate: 0,
      candidatesObserved: 0, blockedCandidates: 0, outsideAppCandidates: 0, appBoundaryDeclared: false, appBoundaryObserved: false,
      appStateChecks: 0, appTerminationFindings: 0, crashDialogFindings: 0, logOracleEnabled: false, logChecks: 0, logCrashFindings: 0,
      actions: 0, cleanupAttempted: false, cleanupFailed: false,
    },
    githubQa: { enabled: true, memoryExisted: true, untracked: 0, newIssues: 1, persistent: 2, resolved: 3, memoryUpdated: false },
    ux: {
      enabled: true, pagesAttempted: 1, pagesAnalyzed: 1, pagesFailed: 0, completeness: 1, valid: true, score: 70,
      opportunities: 1, highImpact: 1, mediumImpact: 0, lowImpact: 0,
      reasonerStatus: {
        configured: false, attempted: false, used: false, repairAttempted: false, fallbackUsed: false, outcome: 'not-configured',
      },
      reasonerUsed: false,
    },
    uxLearning: { enabled: true, memoryExisted: true, status: 'stable', memoryUpdated: false },
    outputDir: runDir,
  };
}

const ux: UxOpportunity = {
  id: 'UX-1',
  category: 'accessibility',
  impact: 'high',
  confidence: 0.98,
  title: 'Icon controls need names',
  observation: 'Several icon-only buttons are unlabeled.',
  recommendation: 'Add visible labels or aria-label.',
  expectedEffect: 'Improves screen-reader discoverability.',
  metric: 'unlabeled controls',
  source: 'deterministic',
};

describe('beta7 evidence report', () => {
  it('writes an offline HTML, structured JSON and executive Markdown report with relative evidence paths', async () => {
    const { runDir, screenshot, video } = await fixture();
    const summary = await generateEvidenceReport({
      runDir,
      result: result(runDir, screenshot),
      uxOpportunities: [ux],
      videos: [{ viewport: 'tablet', path: video }],
    });

    expect(summary.enabled).toBe(true);
    expect(summary.videos).toBe(1);
    expect(summary.findings).toBe(1);
    const html = await readFile(summary.htmlPath!, 'utf8');
    const data = await readFile(summary.dataPath!, 'utf8');
    const markdown = await readFile(summary.markdownPath!, 'utf8');

    expect(html).toContain('BUG-0001');
    expect(html).toContain('../screenshots/finding.png');
    expect(html).toContain('../videos/tablet.webm');
    expect(html).toContain('SOURCE_NOT_CONFIRMED');
    expect(html).toContain('Add visible labels or aria-label.');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('<strong>100%</strong><span>Page coverage</span>');
    expect(html).toContain('<strong>40%</strong><span>Interaction coverage</span>');
    expect(html).not.toContain('10000%');
    expect(html).not.toContain('4000%');
    expect(data).toContain('"status": "new"');
    expect(data).toContain('"classification": "potential-product-defect"');
    expect(data).toContain('"pageCoverage": 100');
    expect(data).toContain('"interactionCoverage": 40');
    expect(data).not.toContain(runDir);
    expect(markdown).toContain('PASS_WITH_ISSUES');
    expect(markdown).toContain('- Page coverage: 100%');
    expect(markdown).toContain('- Interaction coverage: 40%');
    expect(markdown).toContain('[potential-product-defect]');
    expect(markdown).toContain('Inspect the component width/height');
  });

  it('does not clamp an entirely offscreen element into a misleading screenshot marker', async () => {
    const { runDir, screenshot } = await fixture();
    const qa = result(runDir, screenshot);
    const message = 'Interactive element is unreachable or clipped by the viewport: a.navbar-brand-text "LeeEng" [viewport=desktop 1440x1000]';
    qa.events = [{
      timestamp: '2026-08-20T00:00:05.000Z',
      kind: 'ui',
      url: 'https://example.com/settings',
      message,
      details: {
        visual: true,
        visualKind: 'interactive-offscreen',
        viewport: 'desktop',
        viewportWidth: 1440,
        viewportHeight: 1000,
        screenshot,
        element: 'a.navbar-brand-text "LeeEng"',
        rect: { x: -140, y: 25, width: 64, height: 29 },
      },
    }];
    qa.findings = [{
      id: 'BUG-0002', kind: 'ui', severity: 'medium', title: 'Interactive control outside viewport',
      url: 'https://example.com/settings', message, reproduction: ['Open settings'], evidence: [screenshot], fingerprint: 'offscreen-1',
    }];

    const summary = await generateEvidenceReport({ runDir, result: qa, uxOpportunities: [] });
    const html = await readFile(summary.htmlPath!, 'utf8');
    const parsed = JSON.parse(await readFile(summary.dataPath!, 'utf8')) as { findings: Array<Record<string, unknown>> };
    const finding = parsed.findings[0]!;

    expect(finding.classification).toBe('potential-product-defect');
    expect(finding.confidence).toBe(0.65);
    expect(finding.annotationStatus).toBe('unverified');
    expect(String(finding.annotationReason)).toContain('entirely outside the screenshot viewport');
    expect(html).toContain('Annotation unverified');
    expect(html).not.toContain('<span>BUG-0002</span>');
  });

  it('records an explicit reason when a visual finding lacks screenshot evidence', async () => {
    const { runDir, screenshot } = await fixture();
    const qa = result(runDir, screenshot);
    qa.events[0]!.details = { ...qa.events[0]!.details, screenshot: undefined };
    qa.findings[0]!.evidence = [];

    const summary = await generateEvidenceReport({ runDir, result: qa, uxOpportunities: [] });
    const parsed = JSON.parse(await readFile(summary.dataPath!, 'utf8')) as { findings: Array<Record<string, unknown>> };
    expect(parsed.findings[0]?.screenshot).toBeUndefined();
    expect(parsed.findings[0]?.screenshotReason).toBe('Visual finding has no screenshot evidence available within this QA run.');
  });
});
