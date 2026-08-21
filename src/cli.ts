#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { z } from 'zod';
import { loadDotEnv } from './config/load-env.js';
import { QaManager } from './core/qa-manager.js';
import { normalizeRouteSeeds, parseRouteManifest } from './planning/route-manifest.js';
import { isSecureServiceEndpoint, isSecureVisualEndpoint } from './security/url-policy.js';

loadDotEnv();

function parseCapabilitiesJson(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('device capabilities must be JSON text');
  if (value.length > 20_000) throw new Error('device capabilities JSON exceeds 20,000 characters');
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('device capabilities JSON must be an object');
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length > 100) throw new Error('device capabilities JSON may contain at most 100 top-level keys');
  return record;
}

const program = new Command();
program
  .name('aiqa')
  .description('Autonomous browser, visual, API, device, UX and evidence-report QA explorer')
  .requiredOption('-u, --url <url>', 'target URL')
  .option('--routes-file <path>', 'bounded JSON/newline route manifest used to seed otherwise-unlinked frontend routes')
  .option('--max-actions <number>', 'maximum browser actions', '40')
  .option('--max-depth <number>', 'maximum crawl depth', '2')
  .option('--max-candidates-per-page <number>', 'maximum balanced navigation/interaction candidates considered per page', '12')
  .option('--risk-mode <mode>', 'safe or standard', 'safe')
  .option('--visual-viewports <list>', 'comma-separated desktop,tablet,mobile', 'desktop,mobile')
  .option('--visual-baseline <file>', 'visual regression baseline manifest', '.qa-baselines/visual.json')
  .option('--update-visual-baseline', 'replace visual regression baseline with current deterministic signals', false)
  .option('--record-video', 'record visual QA viewport videos and link them from the HTML evidence report', false)
  .option('--no-evidence-report', 'disable the offline HTML/JSON/Markdown evidence report')
  .option('--api-mode <mode>', 'off, discover, safe or sandbox', 'safe')
  .option('--max-api-operations <number>', 'maximum OpenAPI operations executed by the API agent', '25')
  .option('--confirm-disposable-target', 'required with --api-mode sandbox', false)
  .option('--no-semantic-state', 'disable read-only API↔UI semantic state comparison')
  .option('--device-mode <mode>', 'off, smoke or explore', 'off')
  .option('--device-platform <platform>', 'android or ios')
  .option('--max-device-actions <number>', 'maximum low-risk mobile taps in explore mode', '10')
  .option('--appium-endpoint <url>', 'Appium server URL; HTTPS required except localhost/loopback')
  .option('--device-capabilities-json <json>', 'additional bounded W3C/Appium capabilities')
  .option('--planner-endpoint <url>', 'optional AI planner gateway endpoint; overrides MiniMax direct planner')
  .option('--visual-endpoint <url>', 'optional screenshot evidence gateway')
  .option('--minimax-model <model>', 'MiniMax CN model (or MINIMAX_MODEL)')
  .option('--minimax-base-url <url>', 'MiniMax CN OpenAI-compatible base URL (or MINIMAX_BASE_URL)')
  .option('--no-github-plan', 'disable local sanitized GitHub issue-plan generation')
  .option('--github-memory <file>', 'GitHub finding regression memory', '.qa-memory/github-findings.json')
  .option('--update-github-regression-memory', 'explicitly update GitHub finding memory', false)
  .option('--control-plane-state <file>', 'record this run into the M8 control-plane state file')
  .option('--no-ux-intelligence', 'disable M9 autonomous UX/product intelligence')
  .option('--ux-endpoint <url>', 'optional aggregate-only UX reasoner gateway; overrides MiniMax direct reasoner')
  .option('--ux-memory <file>', 'M10 UX learning memory', '.qa-memory/ux-learning.json')
  .option('--ux-product <key>', 'stable product key for UX learning comparisons')
  .option('--update-ux-memory', 'explicitly accept current valid UX score/opportunities as product baseline', false)
  .option('--headed', 'show browser window', false)
  .option('--output <dir>', 'evidence directory', '.qa-runs')
  .option('--allow-cross-origin', 'allow navigation outside the starting origin', false);

program.parse();
const raw = program.opts();
const visualViewports = String(raw.visualViewports).split(',').map((value) => value.trim()).filter(Boolean);
const deviceCapabilities = parseCapabilitiesJson(raw.deviceCapabilitiesJson ?? process.env.AIQA_DEVICE_CAPABILITIES);
const secureEndpoint = z.string().url().refine(isSecureServiceEndpoint, { message: 'endpoint must use HTTPS unless localhost/loopback' });
const schema = z.object({
  url: z.string().url(), routesFile: z.string().min(1).max(4096).optional(), maxActions: z.coerce.number().int().min(1).max(1000), maxDepth: z.coerce.number().int().min(0).max(20),
  maxCandidatesPerPage: z.coerce.number().int().min(1).max(100), riskMode: z.enum(['safe', 'standard']),
  visualViewports: z.array(z.enum(['desktop', 'tablet', 'mobile'])).min(1).max(3), visualBaselinePath: z.string().min(1), updateVisualBaseline: z.boolean(),
  recordVideo: z.boolean(), evidenceReport: z.boolean(),
  apiMode: z.enum(['off', 'discover', 'safe', 'sandbox']), maxApiOperations: z.coerce.number().int().min(1).max(500), confirmDisposableTarget: z.boolean(), semanticState: z.boolean(),
  deviceMode: z.enum(['off', 'smoke', 'explore']), devicePlatform: z.enum(['android', 'ios']).optional(), deviceMaxActions: z.coerce.number().int().min(1).max(50),
  appiumEndpoint: secureEndpoint.optional(), deviceCapabilities: z.unknown().optional(), plannerEndpoint: z.string().url().optional(), plannerToken: z.string().min(1).optional(),
  visualEndpoint: z.string().url().refine(isSecureVisualEndpoint, { message: 'visual endpoint must use HTTPS unless localhost/loopback' }).optional(), visualToken: z.string().min(1).optional(),
  minimaxApiKey: z.string().min(1).optional(), minimaxModel: z.string().min(1).max(120), minimaxBaseUrl: secureEndpoint,
  githubPlan: z.boolean(), githubMemory: z.string().min(1), updateGithubMemory: z.boolean(), controlPlaneState: z.string().min(1).optional(),
  uxIntelligence: z.boolean(), uxEndpoint: secureEndpoint.optional(), uxMemory: z.string().min(1), uxProduct: z.string().regex(/^[A-Za-z0-9._/@:-]+$/).max(200).optional(), updateUxMemory: z.boolean(),
  headed: z.boolean(), output: z.string().min(1), allowCrossOrigin: z.boolean(),
}).superRefine((value, context) => {
  if (value.apiMode === 'sandbox' && value.confirmDisposableTarget !== true) context.addIssue({ code: 'custom', path: ['confirmDisposableTarget'], message: '--api-mode sandbox requires --confirm-disposable-target' });
  if (value.deviceMode !== 'off') {
    if (!value.devicePlatform) context.addIssue({ code: 'custom', path: ['devicePlatform'], message: `--device-mode ${value.deviceMode} requires --device-platform` });
    if (!value.appiumEndpoint) context.addIssue({ code: 'custom', path: ['appiumEndpoint'], message: `--device-mode ${value.deviceMode} requires --appium-endpoint or AIQA_APPIUM_ENDPOINT` });
  }
  if (!value.uxIntelligence && value.updateUxMemory) context.addIssue({ code: 'custom', path: ['updateUxMemory'], message: '--update-ux-memory requires UX intelligence to be enabled' });
});

const options = schema.parse({
  url: raw.url, routesFile: raw.routesFile, maxActions: raw.maxActions, maxDepth: raw.maxDepth, maxCandidatesPerPage: raw.maxCandidatesPerPage, riskMode: raw.riskMode,
  visualViewports, visualBaselinePath: raw.visualBaseline, updateVisualBaseline: raw.updateVisualBaseline,
  recordVideo: raw.recordVideo, evidenceReport: raw.evidenceReport,
  apiMode: raw.apiMode, maxApiOperations: raw.maxApiOperations,
  confirmDisposableTarget: raw.confirmDisposableTarget, semanticState: raw.semanticState, deviceMode: raw.deviceMode,
  devicePlatform: raw.devicePlatform ?? process.env.AIQA_DEVICE_PLATFORM, deviceMaxActions: raw.maxDeviceActions,
  appiumEndpoint: raw.appiumEndpoint ?? process.env.AIQA_APPIUM_ENDPOINT, deviceCapabilities,
  plannerEndpoint: raw.plannerEndpoint ?? process.env.AIQA_PLANNER_ENDPOINT, plannerToken: process.env.AIQA_PLANNER_TOKEN,
  visualEndpoint: raw.visualEndpoint ?? process.env.AIQA_VISUAL_ENDPOINT, visualToken: process.env.AIQA_VISUAL_TOKEN,
  minimaxApiKey: process.env.MINIMAX_API_KEY,
  minimaxModel: raw.minimaxModel ?? process.env.MINIMAX_MODEL ?? 'minimax-m3',
  minimaxBaseUrl: raw.minimaxBaseUrl ?? process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
  githubPlan: raw.githubPlan, githubMemory: raw.githubMemory, updateGithubMemory: raw.updateGithubRegressionMemory,
  controlPlaneState: raw.controlPlaneState, uxIntelligence: raw.uxIntelligence,
  uxEndpoint: raw.uxEndpoint ?? process.env.AIQA_UX_ENDPOINT, uxMemory: raw.uxMemory, uxProduct: raw.uxProduct, updateUxMemory: raw.updateUxMemory,
  headed: raw.headed, output: raw.output, allowCrossOrigin: raw.allowCrossOrigin,
});

const routeSeeds = options.routesFile
  ? normalizeRouteSeeds(options.url, parseRouteManifest(await readFile(options.routesFile, 'utf8')).routes, !options.allowCrossOrigin)
  : [];

const result = await new QaManager().run({
  url: options.url, routeSeeds, maxActions: options.maxActions, maxDepth: options.maxDepth, maxCandidatesPerPage: options.maxCandidatesPerPage,
  headless: !options.headed, outputDir: options.output, sameOriginOnly: !options.allowCrossOrigin, riskMode: options.riskMode,
  visualViewports: options.visualViewports, visualBaselinePath: options.visualBaselinePath, updateVisualBaseline: options.updateVisualBaseline,
  recordVideo: options.recordVideo, evidenceReport: options.evidenceReport,
  apiMode: options.apiMode, maxApiOperations: options.maxApiOperations, confirmDisposableTarget: options.confirmDisposableTarget, semanticState: options.semanticState,
  deviceMode: options.deviceMode, devicePlatform: options.devicePlatform, deviceMaxActions: options.deviceMaxActions,
  appiumEndpoint: options.appiumEndpoint, appiumToken: process.env.AIQA_APPIUM_TOKEN, deviceCapabilities: options.deviceCapabilities as Record<string, unknown> | undefined,
  plannerEndpoint: options.plannerEndpoint, plannerToken: options.plannerToken, visualEndpoint: options.visualEndpoint, visualToken: options.visualToken,
  githubQa: options.githubPlan, githubMemoryPath: options.githubMemory, updateGithubMemory: options.updateGithubMemory,
  controlPlanePath: options.controlPlaneState, uxIntelligence: options.uxIntelligence, uxEndpoint: options.uxEndpoint,
  uxToken: process.env.AIQA_UX_TOKEN, uxMemoryPath: options.uxMemory, uxProductKey: options.uxProduct, updateUxMemory: options.updateUxMemory,
  minimaxApiKey: options.minimaxApiKey, minimaxModel: options.minimaxModel, minimaxBaseUrl: options.minimaxBaseUrl,
});

const clusterSummary = result.findingClusters
  ? {
      rawFindings: result.findingClusters.rawFindings,
      clusters: result.findingClusters.clusters,
      duplicateFindings: result.findingClusters.duplicateFindings,
    }
  : undefined;

console.log(JSON.stringify({
  runId: result.runId,
  // Legacy labels remain for Beta.9 consumers; the structured execution fields
  // below are authoritative for whether configured AI actually participated.
  planner: options.plannerEndpoint ? 'http-model' : options.minimaxApiKey ? `minimax-cn:${options.minimaxModel}` : 'heuristic',
  plannerExecution: result.planner,
  uxReasoner: options.uxEndpoint ? 'http-reasoner' : options.minimaxApiKey ? `minimax-cn:${options.minimaxModel}` : 'deterministic-only',
  uxReasonerExecution: result.ux?.reasonerStatus,
  visualEvidence: options.visualEndpoint ? 'http-provider' : 'geometry-only',
  routeManifest: { enabled: Boolean(options.routesFile), seeded: routeSeeds.length },
  visualViewports: options.visualViewports, visualBaseline: result.visualBaseline, api: result.api, correlation: result.correlation,
  semanticState: result.semanticState, device: result.device, githubQa: result.githubQa, controlPlane: result.controlPlane, ux: result.ux, uxLearning: result.uxLearning,
  report: result.report,
  visited: result.visitedUrls.length, actions: result.actions,
  coverage: {
    score: result.coverage.score,
    pageCoverage: result.coverage.pageCoverage,
    interactionCoverage: result.coverage.interactionCoverage,
    rawInteractionCoverage: result.coverage.rawInteractionCoverage ?? result.coverage.interactionCoverage,
    eligibleInteractionCoverage: result.coverage.eligibleInteractionCoverage ?? result.coverage.interactionCoverage,
    discoveredInteractions: result.coverage.discoveredInteractions,
    allowedInteractions: result.coverage.allowedInteractions,
    eligibleInteractions: result.coverage.eligibleInteractions,
    exercisedEligibleInteractions: result.coverage.exercisedEligibleInteractions,
    explainedEligibleGaps: result.coverage.explainedEligibleGaps,
    unexplainedEligibleGaps: result.coverage.unexplainedEligibleGaps,
    gapReasonCounts: result.coverage.gapReasonCounts,
    gaps: result.coverage.gaps.slice(0, 10),
  },
  findingClusters: clusterSummary,
  findings: result.findings.map(({ id, severity, title, url }) => ({ id, severity, title, url })), outputDir: result.outputDir,
}, null, 2));
if (result.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high')) process.exitCode = 2;
