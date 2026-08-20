import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ControlPlaneSummary,
  GitHubQaSummary,
  QaRunOptions,
  QaRunResult,
  SemanticStateSummary,
  UxIntelligenceSummary,
  UxLearningSummary,
  VisualBaselineSummary,
} from './types.js';
import { ApiAgent } from '../agents/api-agent.js';
import { BrowserExplorer } from '../agents/browser-explorer.js';
import { DeviceAgent } from '../agents/device-agent.js';
import { SemanticStateAgent } from '../agents/semantic-state-agent.js';
import { UxAgent, uxBaselineEligible } from '../agents/ux-agent.js';
import { resolveVisualViewports, VisualAgent } from '../agents/visual-agent.js';
import { ControlPlaneStore } from '../control/control-plane.js';
import { CausalCorrelator } from '../correlation/causal-correlator.js';
import { EvidenceStore } from '../evidence/evidence-store.js';
import { GitHubQaPlanner } from '../github/github-qa-planner.js';
import { CoverageGraph } from '../planning/coverage-graph.js';
import { QaPlanner } from '../planning/qa-planner.js';
import { HttpPlannerModel } from '../providers/http-planner-model.js';
import { HttpUxReasoner } from '../providers/http-ux-reasoner.js';
import { HttpVisualEvidenceProvider } from '../providers/http-visual-evidence-provider.js';
import { MiniMaxPlannerModel } from '../providers/minimax-planner-model.js';
import { MiniMaxUxReasoner } from '../providers/minimax-ux-reasoner.js';
import { findingsFromEvents } from '../reporting/bug-reporter.js';
import { UxLearningStore } from '../ux/ux-learning-store.js';
import { VisualBaselineStore } from '../visual/visual-baseline-store.js';

function emptyGitHubSummary(enabled: boolean): GitHubQaSummary {
  return { enabled, memoryExisted: false, untracked: 0, newIssues: 0, persistent: 0, resolved: 0, memoryUpdated: false };
}

function emptyUxSummary(enabled: boolean): UxIntelligenceSummary {
  return {
    enabled,
    pagesAttempted: 0,
    pagesAnalyzed: 0,
    pagesFailed: 0,
    completeness: 0,
    valid: false,
    score: 0,
    opportunities: 0,
    highImpact: 0,
    mediumImpact: 0,
    lowImpact: 0,
    reasonerUsed: false,
  };
}

export class QaManager {
  async run(options: QaRunOptions): Promise<QaRunResult> {
    const startedAt = new Date().toISOString();
    const runId = `${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const evidence = new EvidenceStore(options.outputDir, runId);
    await evidence.init();

    const coverageGraph = new CoverageGraph();
    const plannerModel = options.plannerEndpoint
      ? new HttpPlannerModel(options.plannerEndpoint, options.plannerToken)
      : options.minimaxApiKey
        ? new MiniMaxPlannerModel(options.minimaxApiKey, options.minimaxModel, options.minimaxBaseUrl)
        : undefined;
    const planner = new QaPlanner(coverageGraph, undefined, plannerModel);
    const explorer = new BrowserExplorer(evidence, planner, coverageGraph);
    const exploration = await explorer.run(options);

    const visualEvidenceProvider = options.visualEndpoint ? new HttpVisualEvidenceProvider(options.visualEndpoint, options.visualToken) : undefined;
    const visualAgent = new VisualAgent(evidence, undefined, resolveVisualViewports(options.visualViewports), exploration.storageState, visualEvidenceProvider);
    const visual = await visualAgent.run(exploration.visitedUrls);

    let visualEvents = visual.events;
    let visualBaseline: VisualBaselineSummary = { enabled: false, existed: false, newSignals: 0, persistentSignals: 0, resolvedSignals: 0, updated: false };
    if (options.visualBaselinePath) {
      const baselineStore = new VisualBaselineStore(options.visualBaselinePath);
      const comparison = await baselineStore.compare(visual.events);
      visualEvents = comparison.events;
      visualBaseline = comparison.summary;
      if (options.updateVisualBaseline) {
        if (visual.analyzedStates <= 0) {
          visualBaseline = { ...visualBaseline, updated: false, error: 'refusing to update visual baseline because zero visual states were successfully analyzed' };
          visualEvents.push({
            timestamp: new Date().toISOString(),
            kind: 'snapshot',
            url: exploration.visitedUrls[0] ?? options.url,
            message: 'Visual baseline update refused because analysis produced no valid page states',
            details: { visualBaseline: true, analyzedStates: visual.analyzedStates, baselineUpdateRefused: true },
          });
        } else {
          await baselineStore.save(comparison.current, visual.analyzedStates);
          visualBaseline = { ...visualBaseline, updated: true };
          visualEvents.push({
            timestamp: new Date().toISOString(),
            kind: 'snapshot',
            url: exploration.visitedUrls[0] ?? options.url,
            message: 'Visual regression baseline updated',
            details: { visualBaseline: true, path: options.visualBaselinePath, entries: comparison.current.length, analyzedStates: visual.analyzedStates },
          });
        }
      }
    }

    const apiMode = options.apiMode ?? 'safe';
    const api = await new ApiAgent().run({
      url: options.url, mode: apiMode, maxOperations: options.maxApiOperations ?? 25,
      storageState: exploration.storageState, confirmDisposableTarget: options.confirmDisposableTarget,
    });

    let semanticEvents = [] as Awaited<ReturnType<SemanticStateAgent['run']>>['events'];
    let semanticState: SemanticStateSummary = { enabled: false, apiFactsObserved: 0, uiFieldsObserved: 0, comparisons: 0, matches: 0, mismatches: 0, ambiguousSkipped: 0 };
    if (options.semanticState !== false && (apiMode === 'safe' || apiMode === 'sandbox')) {
      const semantic = await new SemanticStateAgent().run({
        url: options.url, visitedUrls: exploration.visitedUrls, maxOperations: options.maxApiOperations ?? 25, storageState: exploration.storageState,
      });
      semanticEvents = semantic.events;
      semanticState = semantic.summary;
    }

    const device = await new DeviceAgent(evidence).run({
      mode: options.deviceMode ?? 'off', platform: options.devicePlatform, maxActions: options.deviceMaxActions ?? 10,
      riskMode: options.riskMode, appiumEndpoint: options.appiumEndpoint, appiumToken: options.appiumToken, capabilities: options.deviceCapabilities,
    });

    const correlation = new CausalCorrelator().correlate(exploration.events, api.events);
    const events = [...exploration.events, ...visualEvents, ...api.events, ...correlation.events, ...semanticEvents, ...device.events];
    const findings = findingsFromEvents(events);

    let ux = emptyUxSummary(options.uxIntelligence !== false);
    let uxLearning: UxLearningSummary = { enabled: options.uxIntelligence !== false, memoryExisted: false, status: 'untracked', memoryUpdated: false };
    if (options.uxIntelligence !== false) {
      try {
        const reasoner = options.uxEndpoint
          ? new HttpUxReasoner(options.uxEndpoint, options.uxToken)
          : options.minimaxApiKey
            ? new MiniMaxUxReasoner(options.minimaxApiKey, options.minimaxModel, options.minimaxBaseUrl)
            : undefined;
        const analyzed = await new UxAgent(exploration.storageState, reasoner).run(exploration.visitedUrls, events, exploration.uxSnapshots);
        const opportunityPath = path.join(evidence.runDir, 'ux-opportunities.json');
        await writeFile(opportunityPath, `${JSON.stringify({ version: 1, runId, summary: analyzed.summary, flow: analyzed.flow, opportunities: analyzed.opportunities }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        ux = { ...analyzed.summary, opportunityPath };

        const productKey = options.uxProductKey ?? new URL(options.url).host;
        const memoryPath = options.uxMemoryPath ?? '.qa-memory/ux-learning.json';
        uxLearning = { enabled: true, productKey, memoryPath, memoryExisted: false, status: 'untracked', currentScore: ux.score, memoryUpdated: false };
        const eligible = uxBaselineEligible(analyzed.summary);
        if (eligible) {
          const store = new UxLearningStore(memoryPath);
          const comparison = await store.compare(productKey, ux.score);
          uxLearning = { ...uxLearning, ...comparison };
          if (options.updateUxMemory) {
            await store.saveBaseline(productKey, ux.score, analyzed.opportunities.map((item) => item.id));
            uxLearning.memoryUpdated = true;
          }
        } else {
          uxLearning.toolingError = `UX learning comparison/update refused: analysis completeness ${Math.round(analyzed.summary.completeness * 100)}% (${analyzed.summary.pagesAnalyzed}/${analyzed.summary.pagesAttempted} pages)`;
        }
      } catch (error: unknown) {
        ux = { ...ux, toolingError: String(error) };
        uxLearning = { ...uxLearning, toolingError: String(error) };
      }
    }

    let githubQa = emptyGitHubSummary(options.githubQa !== false);
    if (options.githubQa !== false) {
      try {
        githubQa = (await new GitHubQaPlanner().run({
          enabled: true, runId, runDir: evidence.runDir, findings,
          memoryPath: options.githubMemoryPath ?? '.qa-memory/github-findings.json', updateMemory: options.updateGithubMemory,
        })).summary;
      } catch (error: unknown) {
        githubQa = { ...githubQa, toolingError: String(error) };
      }
    }

    const controlPlane: ControlPlaneSummary = { enabled: Boolean(options.controlPlanePath), statePath: options.controlPlanePath, runRecorded: false };
    const result: QaRunResult = {
      runId, startedAt, finishedAt: new Date().toISOString(), visitedUrls: exploration.visitedUrls, actions: exploration.actions,
      events, findings, coverage: coverageGraph.snapshot(), visualBaseline, api: api.summary, correlation: correlation.summary,
      semanticState, device: device.summary, githubQa, controlPlane, ux, uxLearning, outputDir: evidence.runDir,
    };

    if (options.controlPlanePath) {
      try {
        await new ControlPlaneStore(options.controlPlanePath).recordRun(result);
        controlPlane.runRecorded = true;
      } catch (error: unknown) {
        controlPlane.toolingError = String(error);
      }
    }

    await evidence.writeEvents(result.events);
    await evidence.writeResult(result);
    return result;
  }
}
