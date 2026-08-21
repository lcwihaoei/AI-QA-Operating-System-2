import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatPercentagePoint, type AnnotationStatus, type FindingVerdict, type ReproductionStatus } from '../contracts/quality-contracts.js';
import type { Finding, QaEvent, QaReportSummary, QaRunResult, Severity } from '../core/types.js';
import { validateOffscreenAnnotation, validateOverlapAnnotation } from '../evidence/annotation-validator.js';
import type { UxOpportunity } from '../ux/ux-types.js';

export type ReportClassification = 'product-defect' | 'potential-product-defect' | 'qa-engine' | 'test-defect' | 'environment' | 'ux-opportunity';
export type ReportFindingStatus = 'new' | 'persistent' | 'resolved' | 'untracked';

interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReportSourceMapping {
  status: 'confirmed' | 'unconfirmed';
  file?: string;
  symbol?: string;
  selector?: string;
}

interface ReportFinding {
  id: string;
  severity: Severity;
  classification: ReportClassification;
  status: ReportFindingStatus;
  confidence: number;
  title: string;
  url: string;
  message: string;
  expected: string;
  actual: string;
  reproduction: string[];
  reproductionStatus?: ReproductionStatus;
  reproductionReason?: string;
  truthReasons?: string[];
  screenshot?: string;
  screenshotReason?: string;
  video?: string;
  videoOffsetSeconds?: number;
  viewport?: string;
  rect?: RectLike;
  relatedRect?: RectLike;
  viewportWidth?: number;
  viewportHeight?: number;
  annotationStatus?: AnnotationStatus;
  annotationReason?: string;
  annotationRect?: RectLike;
  sourceMapping: ReportSourceMapping;
  rootCause: string;
  recommendation: string;
  regressionRisk: string;
  regressionTest: string;
}

export interface EvidenceVideo {
  viewport: string;
  path: string;
}

export interface EvidenceReportInput {
  runDir: string;
  result: QaRunResult;
  uxOpportunities?: UxOpportunity[];
  videos?: EvidenceVideo[];
}

interface ReportData {
  schemaVersion: 1;
  generatedAt: string;
  run: {
    id: string;
    startedAt: string;
    finishedAt: string;
    durationSeconds: number;
    visitedUrls: number;
    actions: number;
    coverageScore: number;
    pageCoverage: number;
    interactionCoverage: number;
  };
  verdict: 'PASS' | 'PASS_WITH_ISSUES' | 'FAIL';
  counts: Record<Severity, number>;
  regression: {
    visualNew: number;
    visualPersistent: number;
    visualResolved: number;
    githubNew: number;
    githubPersistent: number;
    githubResolved: number;
  };
  findings: ReportFinding[];
  uxOpportunities: UxOpportunity[];
  quickWins: Array<{ title: string; recommendation: string; impact: string; confidence: number }>;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rect(value: unknown): RectLike | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const x = number(source.x);
  const y = number(source.y);
  const width = number(source.width);
  const height = number(source.height);
  if ([x, y, width, height].some((item) => item === undefined)) return undefined;
  return { x: x!, y: y!, width: width!, height: height! };
}

function findingEvent(finding: Finding, events: QaEvent[]): QaEvent | undefined {
  return events.find((event) => event.url === finding.url && event.message === finding.message)
    ?? events.find((event) => event.message === finding.message);
}

function baselineStatus(event: QaEvent | undefined): ReportFindingStatus {
  const state = event?.details?.baselineState;
  if (state === 'new' || state === 'persistent' || state === 'untracked') return state;
  return 'untracked';
}

function classificationFromVerdict(verdict: FindingVerdict): ReportClassification {
  switch (verdict) {
    case 'confirmed-product-defect': return 'product-defect';
    case 'potential-product-defect': return 'potential-product-defect';
    case 'qa-engine-false-positive': return 'qa-engine';
    case 'test-defect': return 'test-defect';
    case 'environment': return 'environment';
    case 'ux-opportunity': return 'ux-opportunity';
  }
}

function classification(finding: Finding, event: QaEvent | undefined): ReportClassification {
  if (finding.truth) return classificationFromVerdict(finding.truth.verdict);
  const judged = event?.details?.findingVerdict;
  if (typeof judged === 'string') return classificationFromVerdict(judged as FindingVerdict);
  if (event?.details?.tooling === true) return 'qa-engine';
  if (event?.details?.testDefect === true) return 'test-defect';
  if (event?.details?.environment === true) return 'environment';
  if (event?.details?.visual === true) return 'potential-product-defect';
  return 'product-defect';
}

function confidence(finding: Finding, event: QaEvent | undefined): number {
  const provider = number(event?.details?.evidenceConfidence);
  const ceiling = number(event?.details?.findingConfidenceCeiling);
  let base: number;
  if (event?.details?.visual === true) base = provider !== undefined ? provider : 0.65;
  else if (provider !== undefined) base = provider;
  else if (event?.kind === 'network') base = 0.98;
  else if (event?.kind === 'page-error') base = 0.95;
  else if (event?.kind === 'console') base = 0.9;
  else if (event?.kind === 'assertion') base = 0.93;
  else base = 0.8;

  if (ceiling !== undefined) base = Math.min(base, ceiling);
  if (finding.truth?.verdict === 'qa-engine-false-positive') base = Math.max(base, 0.9);
  return clamp(base, 0, 1);
}

function annotation(
  event: QaEvent | undefined,
  primary: RectLike | undefined,
  related: RectLike | undefined,
  viewportWidth: number | undefined,
  viewportHeight: number | undefined,
): Pick<ReportFinding, 'annotationStatus' | 'annotationReason' | 'annotationRect'> {
  if (!event) return {};
  const canonicalStatus = typeof event.details?.annotationStatus === 'string' ? event.details.annotationStatus as AnnotationStatus : undefined;
  const canonicalReason = typeof event.details?.annotationReason === 'string' ? event.details.annotationReason : undefined;
  const visualKind = typeof event.details?.visualKind === 'string' ? event.details.visualKind : undefined;

  if (visualKind === 'interactive-offscreen' && primary && viewportWidth && viewportHeight) {
    const checked = validateOffscreenAnnotation(primary, viewportWidth, viewportHeight);
    return {
      annotationStatus: canonicalStatus ?? checked.status,
      annotationReason: canonicalReason ?? checked.reason,
      annotationRect: checked.status === 'confirmed' ? checked.intersection : undefined,
    };
  }
  if (visualKind === 'interactive-overlap' && primary && related && viewportWidth && viewportHeight) {
    const checked = validateOverlapAnnotation(primary, related, viewportWidth, viewportHeight);
    return {
      annotationStatus: canonicalStatus ?? checked.status,
      annotationReason: canonicalReason ?? checked.reason,
      annotationRect: checked.status === 'confirmed' ? checked.intersection : undefined,
    };
  }
  if (canonicalStatus) return { annotationStatus: canonicalStatus, annotationReason: canonicalReason };
  return {};
}

function remediation(finding: Finding, event: QaEvent | undefined): Pick<ReportFinding, 'expected' | 'actual' | 'rootCause' | 'recommendation' | 'regressionRisk' | 'regressionTest'> {
  const visualKind = typeof event?.details?.visualKind === 'string' ? event.details.visualKind : undefined;
  if (visualKind === 'text-clipping') {
    return {
      expected: 'Visible content remains readable at the affected viewport without accidental clipping.',
      actual: finding.message,
      rootCause: 'The rendered element has less usable box space than its text requires while overflow rules prevent the remaining content from being displayed.',
      recommendation: 'Inspect the component width/height, flex min-width, overflow and wrapping rules. Remove accidental fixed-height clipping. Keep intentional ellipsis or line-clamp only when the product explicitly wants truncation.',
      regressionRisk: 'Making every clipped block auto-height can change card density and alignment. Fix the owning component rather than globally disabling overflow.',
      regressionTest: 'Add a responsive browser fixture for this route/viewport that asserts the target text has scrollWidth <= clientWidth and scrollHeight <= clientHeight unless truncation is intentional.',
    };
  }
  if (visualKind === 'interactive-offscreen' || finding.title === 'Interactive control outside viewport') {
    return {
      expected: 'Interactive controls are reachable by normal viewport scrolling or an intentional scroll container, while closed navigation/drawer content is not treated as a product defect.',
      actual: finding.message,
      rootCause: 'The control geometry is outside the usable viewport and is not currently proven reachable through an intentional scroll container or closed-state navigation model.',
      recommendation: 'Check the owning responsive layout and closed-state semantics. For product CSS, keep active controls within a reachable container. For intentional closed drawers, expose semantic closed state (aria-hidden/inert/data-state) instead of relying only on transform coordinates.',
      regressionRisk: 'Blanket suppression of sidebar/drawer classes can hide genuine responsive regressions. Pair every false-positive fixture with a visible broken-sidebar true-positive fixture.',
      regressionTest: 'Add paired browser assertions: a semantically closed off-canvas control produces no finding, while a visible horizontally unreachable control still produces interactive-offscreen.',
    };
  }
  if (visualKind === 'interactive-overlap') {
    return {
      expected: 'Independent interactive targets do not substantially overlap in the affected responsive state.',
      actual: finding.message,
      rootCause: 'Two independently actionable hit targets occupy substantially overlapping geometry.',
      recommendation: 'Inspect grid/flex sizing, absolute positioning, stacking and responsive breakpoints for the two controls. Preserve the intended hit area and minimum spacing.',
      regressionRisk: 'Reducing only z-index may leave invisible hit-target overlap. Verify geometry and pointer/focus behavior.',
      regressionTest: 'Add a browser geometry assertion for the affected viewport and verify overlap ratio stays below the deterministic threshold.',
    };
  }
  if (visualKind === 'horizontal-overflow' || finding.title === 'Horizontal layout overflow') {
    return {
      expected: 'The document fits the viewport horizontally unless a scoped component explicitly owns horizontal scrolling.',
      actual: finding.message,
      rootCause: 'One or more descendants expand the document scroll width beyond the root viewport.',
      recommendation: 'Locate the widest overflowing descendant and inspect fixed widths, min-width, transforms and unbroken text. Prefer scoped overflow containers over document-level horizontal scrolling.',
      regressionRisk: 'Applying overflow-x:hidden to the document can conceal inaccessible content instead of fixing layout.',
      regressionTest: 'Assert documentElement.scrollWidth <= documentElement.clientWidth + tolerance at the failing viewport.',
    };
  }
  if (finding.kind === 'network') {
    return {
      expected: 'The application request completes without an unexpected 4xx/5xx response.',
      actual: finding.message,
      rootCause: 'A browser-observed request returned an error response. Correlate the request with the preceding action and server/API evidence before assigning ownership.',
      recommendation: 'Inspect request method/path, authentication, payload and backend logs. Fix the contract or client behavior at the narrowest responsible layer.',
      regressionRisk: 'Mocking the failed endpoint without exercising the real contract can make the regression test meaningless.',
      regressionTest: 'Reproduce the preceding user action and assert the request succeeds with the expected status and response contract.',
    };
  }
  if (finding.kind === 'page-error' || finding.kind === 'console') {
    return {
      expected: 'The exercised user flow completes without uncaught runtime or browser-console errors.',
      actual: finding.message,
      rootCause: 'Runtime evidence indicates an exception or error-level console path during the observed flow.',
      recommendation: 'Trace the error to the nearest application stack/source location, reproduce with the same action sequence, and fix the throwing path rather than suppressing the message.',
      regressionRisk: 'Filtering the console message can hide the symptom while leaving the runtime failure intact.',
      regressionTest: 'Add an end-to-end reproduction that performs the recorded steps and asserts no matching pageerror/console error is emitted.',
    };
  }
  return {
    expected: 'Observed behavior satisfies the product contract for the recorded flow.',
    actual: finding.message,
    rootCause: 'The available evidence proves a quality signal but does not contain enough source-level context to confirm a unique root cause.',
    recommendation: 'Reproduce from the recorded steps, correlate DOM/network/console evidence, then change the narrowest responsible component.',
    regressionRisk: 'Avoid broad suppressions or global style changes until the owning component is confirmed.',
    regressionTest: 'Convert the recorded reproduction into a deterministic regression test before closing the finding.',
  };
}

function safeEvidencePath(runDir: string, reportDir: string, candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const absoluteRun = path.resolve(runDir);
  const absoluteCandidate = path.resolve(candidate);
  const withinRun = absoluteCandidate === absoluteRun || absoluteCandidate.startsWith(`${absoluteRun}${path.sep}`);
  if (!withinRun) return undefined;
  return path.relative(reportDir, absoluteCandidate).split(path.sep).join('/');
}

function sourceMapping(event: QaEvent | undefined): ReportSourceMapping {
  const file = typeof event?.details?.sourceFile === 'string' ? event.details.sourceFile : undefined;
  const symbol = typeof event?.details?.sourceSymbol === 'string' ? event.details.sourceSymbol : undefined;
  const selector = typeof event?.details?.element === 'string' ? event.details.element : undefined;
  return { status: file ? 'confirmed' : 'unconfirmed', file, symbol, selector };
}

function verdict(findings: Finding[]): ReportData['verdict'] {
  const confirmedBlocking = findings.some((item) =>
    (item.severity === 'critical' || item.severity === 'high')
    && (item.truth ? item.truth.verdict === 'confirmed-product-defect' : true));
  if (confirmedBlocking) return 'FAIL';
  if (findings.length > 0) return 'PASS_WITH_ISSUES';
  return 'PASS';
}

function severityCounts(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return counts;
}

function renderFindingCard(item: ReportFinding): string {
  const annotationNote = item.annotationStatus
    ? `<p class="annotation-note"><strong>Annotation ${htmlEscape(item.annotationStatus)}</strong> · ${htmlEscape(item.annotationReason ?? 'No annotation diagnostic provided.')}</p>`
    : '';
  const reproductionNote = item.reproductionStatus
    ? `<p class="truth-note"><strong>Independent reproduction ${htmlEscape(item.reproductionStatus)}</strong>${item.reproductionReason ? ` · ${htmlEscape(item.reproductionReason)}` : ''}</p>`
    : '';
  const truthReasons = item.truthReasons?.length
    ? `<section><h4>Evidence truth</h4><ul>${item.truthReasons.map((reason) => `<li>${htmlEscape(reason)}</li>`).join('')}</ul></section>`
    : '';
  const screenshot = item.screenshot
    ? `<div class="evidence-frame"><img loading="lazy" src="${htmlEscape(item.screenshot)}" alt="Evidence for ${htmlEscape(item.id)}">${renderRectOverlay(item)}</div>${annotationNote}`
    : `<div class="empty-evidence">${htmlEscape(item.screenshotReason ?? 'No screenshot attached to this finding.')}</div>`;
  const video = item.video
    ? `<video controls preload="metadata" src="${htmlEscape(item.video)}${item.videoOffsetSeconds !== undefined ? `#t=${Math.max(0, item.videoOffsetSeconds - 2).toFixed(1)}` : ''}"></video>`
    : '';
  const source = item.sourceMapping.status === 'confirmed'
    ? `${htmlEscape(item.sourceMapping.file ?? '')}${item.sourceMapping.symbol ? ` → ${htmlEscape(item.sourceMapping.symbol)}` : ''}`
    : 'SOURCE_NOT_CONFIRMED';
  return `<article class="finding" data-severity="${item.severity}" data-classification="${item.classification}" data-status="${item.status}">
    <div class="finding-head"><div><span class="issue-id">${item.id}</span><span class="pill ${item.severity}">${item.severity}</span><span class="pill neutral">${item.status}</span><span class="pill neutral">${item.classification}</span></div><div class="confidence">Confidence ${Math.round(item.confidence * 100)}%</div></div>
    <h3>${htmlEscape(item.title)}</h3><p class="route">${htmlEscape(item.url)}${item.viewport ? ` · ${htmlEscape(item.viewport)}` : ''}</p>${reproductionNote}
    <div class="evidence-grid"><div>${screenshot}</div><div>${video || '<div class="empty-evidence">Enable --record-video to attach viewport recordings.</div>'}</div></div>
    <div class="two-col"><section><h4>Expected</h4><p>${htmlEscape(item.expected)}</p></section><section><h4>Actual</h4><p>${htmlEscape(item.actual)}</p></section></div>
    <section><h4>Reproduction</h4><ol>${item.reproduction.map((step) => `<li>${htmlEscape(step)}</li>`).join('')}</ol></section>${truthReasons}
    <div class="two-col"><section><h4>Root cause hypothesis</h4><p>${htmlEscape(item.rootCause)}</p></section><section><h4>Recommended change</h4><p>${htmlEscape(item.recommendation)}</p></section></div>
    <div class="two-col"><section><h4>Source mapping</h4><code>${source}</code>${item.sourceMapping.selector ? `<p class="muted">${htmlEscape(item.sourceMapping.selector)}</p>` : ''}</section><section><h4>Regression risk</h4><p>${htmlEscape(item.regressionRisk)}</p></section></div>
    <section><h4>Required regression test</h4><p>${htmlEscape(item.regressionTest)}</p></section>
  </article>`;
}

function renderRectOverlay(item: ReportFinding): string {
  if (!item.viewportWidth || !item.viewportHeight) return '';
  if (item.annotationStatus && item.annotationStatus !== 'confirmed') return '';
  const target = item.annotationRect ?? item.rect;
  if (!target) return '';
  const left = clamp(target.x / item.viewportWidth * 100, 0, 100);
  const top = clamp(target.y / item.viewportHeight * 100, 0, 100);
  const width = clamp(target.width / item.viewportWidth * 100, 0.5, 100 - left);
  const height = clamp(target.height / item.viewportHeight * 100, 0.5, 100 - top);
  return `<div class="marker" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%;width:${width.toFixed(2)}%;height:${height.toFixed(2)}%"><span>${item.id}</span></div>`;
}

function renderHtml(data: ReportData): string {
  const counts = data.counts;
  const findingCards = data.findings.map(renderFindingCard).join('\n');
  const uxCards = data.uxOpportunities.map((item) => `<article class="ux-card"><div><span class="pill ${item.impact === 'high' ? 'high' : item.impact === 'medium' ? 'medium' : 'low'}">${item.impact}</span><span class="pill neutral">${htmlEscape(item.category)}</span></div><h3>${htmlEscape(item.title)}</h3><p>${htmlEscape(item.observation)}</p><h4>Recommendation</h4><p>${htmlEscape(item.recommendation)}</p><p class="muted">Expected effect: ${htmlEscape(item.expectedEffect)} · confidence ${Math.round(item.confidence * 100)}% · ${htmlEscape(item.source)}</p></article>`).join('\n');
  const quickWins = data.quickWins.map((item) => `<li><strong>${htmlEscape(item.title)}</strong><span>${htmlEscape(item.recommendation)}</span><small>${htmlEscape(item.impact)} · ${Math.round(item.confidence * 100)}%</small></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI QA Evidence Report · ${htmlEscape(data.run.id)}</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#152033;background:#f3f6fb}*{box-sizing:border-box}body{margin:0}header{background:linear-gradient(135deg,#101b35,#263c68);color:#fff;padding:42px max(24px,calc((100vw - 1220px)/2)) 34px}header h1{font-size:34px;margin:8px 0}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:12px;opacity:.72}.verdict{display:inline-flex;padding:7px 12px;border:1px solid #ffffff40;border-radius:999px;background:#ffffff12;font-weight:700}.wrap{max-width:1220px;margin:auto;padding:24px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin-top:-52px}.metric{background:#fff;border:1px solid #dce4f0;border-radius:16px;padding:18px;box-shadow:0 12px 30px #16315b12}.metric strong{font-size:27px;display:block}.metric span{font-size:12px;color:#64748b}.toolbar{position:sticky;top:0;z-index:8;background:#f3f6fbe8;backdrop-filter:blur(10px);padding:14px 0;display:flex;gap:8px;flex-wrap:wrap}.toolbar button,.toolbar select{border:1px solid #ccd7e6;background:#fff;border-radius:10px;padding:9px 12px;color:#263650}h2{margin-top:34px}.finding,.ux-card,.panel{background:#fff;border:1px solid #dce4f0;border-radius:18px;padding:20px;margin:14px 0;box-shadow:0 6px 20px #1937590b}.finding-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.issue-id{font-weight:800;margin-right:8px}.pill{display:inline-block;padding:4px 8px;border-radius:999px;font-size:11px;text-transform:uppercase;font-weight:800;margin-right:5px}.critical,.high{background:#fee2e2;color:#991b1b}.medium{background:#fef3c7;color:#92400e}.low{background:#dbeafe;color:#1e40af}.info,.neutral{background:#e8edf5;color:#45556e}.confidence,.muted,.route{color:#64748b;font-size:13px}.annotation-note,.truth-note{font-size:12px;color:#475569;line-height:1.45;margin:8px 2px 0}.two-col,.evidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.two-col section{background:#f8fafc;border-radius:12px;padding:12px}.finding h4,.ux-card h4{margin:0 0 6px}.finding p,.ux-card p{line-height:1.55}.evidence-frame{position:relative;overflow:auto;max-height:440px;border:1px solid #dbe3ee;border-radius:12px;background:#0f172a}.evidence-frame img{display:block;width:100%;height:auto}.marker{position:absolute;border:3px solid #ef4444;background:#ef44441c;pointer-events:none}.marker span{position:absolute;top:-24px;left:-3px;background:#ef4444;color:#fff;padding:3px 6px;font-size:11px;border-radius:5px}video{width:100%;max-height:440px;background:#0f172a;border-radius:12px}.empty-evidence{min-height:130px;display:grid;place-items:center;padding:18px;text-align:center;color:#64748b;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:12px}.quick-wins{display:grid;gap:9px;padding:0;list-style:none}.quick-wins li{display:grid;grid-template-columns:1.1fr 2fr auto;gap:14px;padding:12px;border-bottom:1px solid #edf1f6}.regression{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.regression div{background:#f8fafc;padding:14px;border-radius:12px}code{white-space:pre-wrap;word-break:break-word}footer{padding:40px;text-align:center;color:#64748b}@media(max-width:760px){.two-col,.evidence-grid,.regression{grid-template-columns:1fr}.metrics{margin-top:-30px}.quick-wins li{grid-template-columns:1fr}.confidence{display:none}}
</style></head><body><header><div class="eyebrow">AI QA Operating System · Evidence-rich report</div><h1>Quality Evidence Report</h1><div class="verdict">${data.verdict.replaceAll('_',' ')}</div><p>Run ${htmlEscape(data.run.id)} · ${htmlEscape(data.generatedAt)}</p></header><main class="wrap"><section class="metrics"><div class="metric"><strong>${data.run.coverageScore}</strong><span>Coverage score</span></div><div class="metric"><strong>${formatPercentagePoint(data.run.pageCoverage)}</strong><span>Page coverage</span></div><div class="metric"><strong>${formatPercentagePoint(data.run.interactionCoverage)}</strong><span>Interaction coverage</span></div><div class="metric"><strong>${data.run.visitedUrls}</strong><span>Visited URLs</span></div><div class="metric"><strong>${data.run.actions}</strong><span>Actions</span></div><div class="metric"><strong>${data.findings.length}</strong><span>Findings</span></div></section>
<div class="toolbar"><select id="severity"><option value="all">All severities</option><option>critical</option><option>high</option><option>medium</option><option>low</option><option>info</option></select><select id="status"><option value="all">All statuses</option><option>new</option><option>persistent</option><option>untracked</option></select><button data-view="executive">Executive</button><button data-view="product">Product / UX</button><button data-view="engineering">Engineering</button><button data-view="all">All</button></div>
<section class="panel executive"><h2>Executive summary</h2><p><strong>${counts.critical}</strong> critical · <strong>${counts.high}</strong> high · <strong>${counts.medium}</strong> medium · <strong>${counts.low}</strong> low · <strong>${counts.info}</strong> info.</p><div class="regression"><div><strong>${data.regression.visualNew}</strong><br>visual new</div><div><strong>${data.regression.visualPersistent}</strong><br>visual persistent</div><div><strong>${data.regression.visualResolved}</strong><br>visual resolved</div></div><h3>Quick wins / high-value improvements</h3><ul class="quick-wins">${quickWins || '<li>No UX opportunities were emitted for this run.</li>'}</ul></section>
<section class="product"><h2>Product & UX opportunities</h2>${uxCards || '<div class="panel">No UX opportunities were emitted.</div>'}</section>
<section class="engineering"><h2>Findings & remediation mapping</h2>${findingCards || '<div class="panel">No product findings were emitted.</div>'}</section>
</main><footer>Generated locally from canonical evidence truth. A visual detector signal is not a confirmed product defect until independent reproduction and evidence checks satisfy the Beta.10 finding contract.</footer><script>
const severity=document.getElementById('severity');const status=document.getElementById('status');function filter(){document.querySelectorAll('.finding').forEach((el)=>{const okSeverity=severity.value==='all'||el.dataset.severity===severity.value;const okStatus=status.value==='all'||el.dataset.status===status.value;el.style.display=okSeverity&&okStatus?'block':'none';});}severity.addEventListener('change',filter);status.addEventListener('change',filter);document.querySelectorAll('[data-view]').forEach((button)=>button.addEventListener('click',()=>{const view=button.dataset.view;document.querySelectorAll('.executive,.product,.engineering').forEach((section)=>{section.style.display=view==='all'||section.classList.contains(view)?'block':'none';});}));
</script></body></html>`;
}

function renderExecutiveMarkdown(data: ReportData): string {
  const top = data.findings.slice(0, 10).map((item) => `- ${item.id} [${item.severity.toUpperCase()}] [${item.classification}] ${item.title} — ${item.recommendation}`).join('\n');
  return `# AI QA Evidence Report\n\n- Run: ${data.run.id}\n- Verdict: ${data.verdict}\n- Visited URLs: ${data.run.visitedUrls}\n- Actions: ${data.run.actions}\n- Coverage score: ${data.run.coverageScore}\n- Page coverage: ${formatPercentagePoint(data.run.pageCoverage)}\n- Interaction coverage: ${formatPercentagePoint(data.run.interactionCoverage)}\n- Findings: ${data.findings.length}\n- UX opportunities: ${data.uxOpportunities.length}\n\n## Regression\n\n- Visual new: ${data.regression.visualNew}\n- Visual persistent: ${data.regression.visualPersistent}\n- Visual resolved: ${data.regression.visualResolved}\n- GitHub new: ${data.regression.githubNew}\n- GitHub persistent: ${data.regression.githubPersistent}\n- GitHub resolved: ${data.regression.githubResolved}\n\n## Top remediation items\n\n${top || '- None'}\n`;
}

async function loadUxFallback(result: QaRunResult): Promise<UxOpportunity[]> {
  const file = result.ux?.opportunityPath;
  if (!file) return [];
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { opportunities?: UxOpportunity[] };
    return Array.isArray(parsed.opportunities) ? parsed.opportunities : [];
  } catch {
    return [];
  }
}

export async function generateEvidenceReport(input: EvidenceReportInput): Promise<QaReportSummary> {
  const reportDir = path.join(input.runDir, 'report');
  await mkdir(reportDir, { recursive: true });
  const uxOpportunities = input.uxOpportunities ?? await loadUxFallback(input.result);
  const videosByViewport = new Map((input.videos ?? []).map((item) => [item.viewport, safeEvidencePath(input.runDir, reportDir, item.path)]));
  const fallbackVideo = input.videos?.length ? safeEvidencePath(input.runDir, reportDir, input.videos[0]!.path) : undefined;
  const startedMs = Date.parse(input.result.startedAt);

  const findings: ReportFinding[] = input.result.findings.map((finding) => {
    const event = findingEvent(finding, input.result.events);
    const viewport = typeof event?.details?.viewport === 'string' ? event.details.viewport : undefined;
    const screenshotCandidate = finding.evidence[0] ?? (typeof event?.details?.screenshot === 'string' ? event.details.screenshot : undefined);
    const screenshot = safeEvidencePath(input.runDir, reportDir, screenshotCandidate);
    const eventMs = event ? Date.parse(event.timestamp) : Number.NaN;
    const video = viewport ? videosByViewport.get(viewport) : fallbackVideo;
    const mapped = sourceMapping(event);
    const fix = remediation(finding, event);
    const primaryRect = rect(event?.details?.rect);
    const relatedRect = rect(event?.details?.relatedRect);
    const viewportWidth = number(event?.details?.viewportWidth);
    const viewportHeight = number(event?.details?.viewportHeight);
    const annotationResult = annotation(event, primaryRect, relatedRect, viewportWidth, viewportHeight);
    const reproductionStatus = finding.truth?.reproduction ?? (typeof event?.details?.reproductionStatus === 'string' ? event.details.reproductionStatus as ReproductionStatus : undefined);
    const reproductionReason = typeof event?.details?.reproductionReason === 'string' ? event.details.reproductionReason : undefined;
    return {
      id: finding.id,
      severity: finding.severity,
      classification: classification(finding, event),
      status: baselineStatus(event),
      confidence: confidence(finding, event),
      title: finding.title,
      url: finding.url,
      message: finding.message,
      reproduction: finding.reproduction,
      reproductionStatus,
      reproductionReason,
      truthReasons: finding.truth?.reasons,
      screenshot,
      screenshotReason: screenshot ? undefined : (finding.truth?.screenshotReason ?? (event?.details?.visual === true
        ? 'Visual finding has no screenshot evidence available within this QA run.'
        : 'No screenshot evidence was attached to this finding.')),
      video,
      videoOffsetSeconds: Number.isFinite(eventMs) && Number.isFinite(startedMs) ? Math.max(0, (eventMs - startedMs) / 1000) : undefined,
      viewport,
      rect: primaryRect,
      relatedRect,
      viewportWidth,
      viewportHeight,
      ...annotationResult,
      sourceMapping: mapped,
      ...fix,
    };
  });

  const durationSeconds = Math.max(0, (Date.parse(input.result.finishedAt) - Date.parse(input.result.startedAt)) / 1000);
  const data: ReportData = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    run: {
      id: input.result.runId,
      startedAt: input.result.startedAt,
      finishedAt: input.result.finishedAt,
      durationSeconds,
      visitedUrls: input.result.visitedUrls.length,
      actions: input.result.actions,
      coverageScore: input.result.coverage.score,
      pageCoverage: input.result.coverage.pageCoverage,
      interactionCoverage: input.result.coverage.interactionCoverage,
    },
    verdict: verdict(input.result.findings),
    counts: severityCounts(input.result.findings),
    regression: {
      visualNew: input.result.visualBaseline.newSignals,
      visualPersistent: input.result.visualBaseline.persistentSignals,
      visualResolved: input.result.visualBaseline.resolvedSignals,
      githubNew: input.result.githubQa?.newIssues ?? 0,
      githubPersistent: input.result.githubQa?.persistent ?? 0,
      githubResolved: input.result.githubQa?.resolved ?? 0,
    },
    findings,
    uxOpportunities,
    quickWins: uxOpportunities
      .filter((item) => item.impact === 'high' || item.confidence >= 0.85)
      .slice(0, 8)
      .map((item) => ({ title: item.title, recommendation: item.recommendation, impact: item.impact, confidence: item.confidence })),
  };

  const dataPath = path.join(reportDir, 'report-data.json');
  const htmlPath = path.join(reportDir, 'index.html');
  const markdownPath = path.join(reportDir, 'executive-summary.md');
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(htmlPath, renderHtml(data), { encoding: 'utf8', mode: 0o600 });
  await writeFile(markdownPath, renderExecutiveMarkdown(data), { encoding: 'utf8', mode: 0o600 });
  return { enabled: true, htmlPath, dataPath, markdownPath, videos: (input.videos ?? []).length, findings: findings.length, uxOpportunities: uxOpportunities.length };
}
