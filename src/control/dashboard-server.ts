import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { BackendVerificationCommand } from '../backend/executor-types.js';
import type { MockMigrationAction } from '../backend/mock-migration.js';
import { discoverFreshBeta7Result } from './beta7-result-discovery.js';
import { Beta8AcceptanceDashboardService } from './beta8-acceptance-service.js';
import { Beta8DashboardActionService } from './beta8-action-service.js';
import { beta8DashboardJs } from './beta8-dashboard.js';
import { beta8DashboardCss } from './beta8-dashboard-ui.js';
import { Beta8MockAcceptanceDashboardService } from './beta8-mock-acceptance-service.js';
import { beta8MockDashboardJs } from './beta8-mock-dashboard.js';
import { beta8MockDashboardCss } from './beta8-mock-dashboard-ui.js';
import { Beta8MockMigrationDashboardService } from './beta8-mock-migration-service.js';
import { beta8QaDashboardJs } from './beta8-qa-dashboard.js';
import { beta8QaDashboardCss } from './beta8-qa-dashboard-ui.js';
import { Beta8QaHandoffService } from './beta8-qa-handoff-service.js';
import { loadBeta8QaHandoffResultPath } from './beta8-qa-handoff-state.js';
import {
  beta9DashboardJs,
  createBeta9SelectionFromDashboard,
  loadBeta9DashboardSummary,
  loadBeta9FindingSource,
} from './beta9-dashboard.js';
import { beta9DashboardCss } from './beta9-dashboard-ui.js';
import { Beta9DashboardActionService } from './beta9-action-service.js';
import { ControlPlaneStore } from './control-plane.js';
import { dashboardCss, dashboardHtml, dashboardJs } from './dashboard-ui.js';

export { dashboardCss, dashboardHtml, dashboardJs } from './dashboard-ui.js';

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  token?: string;
  beta8RepoPath?: string;
  beta8ArtifactRoot?: string;
  beta8ModelEndpoint?: string;
  beta8ModelToken?: string;
  beta8MockModelEndpoint?: string;
  beta8MockModelToken?: string;
  beta8Beta7ResultPath?: string;
  beta8Beta7RunsRoot?: string;
  beta9PlanPath?: string;
  beta7ResultPath?: string;
  beta9RepoPath?: string;
  beta9ModelEndpoint?: string;
  beta9PostResultPath?: string;
  beta9PostResultsRoot?: string;
  beta9ArtifactRoot?: string;
  beta9ModelToken?: string;
  allowActions?: boolean;
}
export function isLoopbackHost(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'; }

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const value = request.headers.authorization ?? '';
  const expected = `Bearer ${token}`;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, contentType: string, body: string, headOnly = false): void {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(headOnly ? '' : body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) throw new Error('dashboard actions require application/json');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 65_536) throw new Error('dashboard action body exceeds 64 KiB');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function requestHostIsLoopback(request: IncomingMessage): boolean {
  const hostHeader = request.headers.host;
  if (!hostHeader) return false;
  try { return isLoopbackHost(new URL(`http://${hostHeader}`).hostname); } catch { return false; }
}

function actionRequestAllowed(request: IncomingMessage, host: string, allowActions: boolean): boolean {
  if (!isLoopbackHost(host) || !allowActions || !requestHostIsLoopback(request)) return false;
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && !['same-origin', 'same-site', 'none'].includes(site.toLowerCase())) return false;
  const origin = request.headers.origin;
  if (typeof origin === 'string') {
    try { if (new URL(origin).host !== request.headers.host) return false; } catch { return false; }
  }
  return true;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('dashboard action body must be a JSON object');
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, max = 500): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${key} must be a non-empty string up to ${max} characters`);
  return value.trim();
}

function verificationCommand(record: Record<string, unknown>, key: string, required = true): BackendVerificationCommand | undefined {
  const value = record[key];
  if (value === undefined && !required) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be a verification command object`);
  const command = value as Record<string, unknown>;
  const program = requiredString(command, 'program', 50);
  if (!Array.isArray(command.args) || command.args.length > 40 || !command.args.every((arg) => typeof arg === 'string' && arg.length <= 500)) {
    throw new Error(`${key}.args must be an array of up to 40 bounded strings`);
  }
  return { program, args: command.args as string[] };
}

function dashboardDocument(): string {
  return dashboardHtml()
    .replace('</head>', '  <link rel="stylesheet" href="/beta8-dashboard.css">\n  <link rel="stylesheet" href="/beta8-mock-dashboard.css">\n  <link rel="stylesheet" href="/beta8-qa-dashboard.css">\n  <link rel="stylesheet" href="/beta9-dashboard.css">\n</head>')
    .replace('</body>', '  <script src="/beta8-dashboard.js" defer></script>\n  <script src="/beta8-mock-dashboard.js" defer></script>\n  <script src="/beta8-qa-dashboard.js" defer></script>\n  <script src="/beta9-dashboard.js" defer></script>\n</body>');
}

function actionErrorStatus(message: string): number {
  if (/not configured|already exists|already running|requires|not available|not permit|not approved|current branch|state|no fresh|multiple fresh|multiple new|not ready|refusing|dependencies|clean working tree|acceptance|mock migration|live backend|final qa|handoff|latest reviewed/i.test(message)) return 409;
  return 400;
}

export async function startDashboard(store: ControlPlaneStore, options: DashboardServerOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const beta8ArtifactRoot = options.beta8ArtifactRoot ?? '.qa-backend';
  const beta9PlanPath = options.beta9PlanPath ?? '.qa-beta9/plan.json';
  const beta9ArtifactRoot = options.beta9ArtifactRoot ?? '.qa-beta9';
  const allowActions = options.allowActions === true;
  if (!isLoopbackHost(host) && !options.token) throw new Error('remote dashboard binding requires a bearer token');
  if (!isLoopbackHost(host) && allowActions) throw new Error('dashboard actions are loopback-only even when remote read access is authenticated');

  const beta8Actions = new Beta8DashboardActionService({
    repoPath: options.beta8RepoPath,
    artifactRoot: beta8ArtifactRoot,
    modelEndpoint: options.beta8ModelEndpoint,
    modelToken: options.beta8ModelToken,
  });
  const beta8Acceptance = options.beta8RepoPath ? new Beta8AcceptanceDashboardService(options.beta8RepoPath, beta8ArtifactRoot) : undefined;
  const beta8MockMigration = new Beta8MockMigrationDashboardService({
    repoPath: options.beta8RepoPath,
    artifactRoot: beta8ArtifactRoot,
    modelEndpoint: options.beta8MockModelEndpoint,
    modelToken: options.beta8MockModelToken,
  });
  const beta8MockAcceptance = options.beta8RepoPath ? new Beta8MockAcceptanceDashboardService(options.beta8RepoPath, beta8ArtifactRoot) : undefined;
  const beta8FinalQa = new Beta8QaHandoffService({
    repoPath: options.beta8RepoPath,
    artifactRoot: beta8ArtifactRoot,
    runsRoot: options.beta8Beta7RunsRoot ?? (options.beta8RepoPath ? path.join(options.beta8RepoPath, '.qa-runs') : undefined),
    exactResultPath: options.beta8Beta7ResultPath,
    beta9PlanPath,
  });

  const resolveBeta9SourceResult = async (): Promise<string | undefined> => {
    if (options.beta7ResultPath) return options.beta7ResultPath;
    if (!options.beta8RepoPath) return undefined;
    return loadBeta8QaHandoffResultPath({ artifactRoot: beta8ArtifactRoot, repoPath: options.beta8RepoPath });
  };
  const beta9ActionConfig = (sourceResultPath: string, postResultPath = options.beta9PostResultPath) => ({
    planPath: beta9PlanPath,
    sourceResultPath,
    repoPath: options.beta9RepoPath ?? options.beta8RepoPath,
    modelEndpoint: options.beta9ModelEndpoint,
    postResultPath,
    artifactRoot: beta9ArtifactRoot,
    modelToken: options.beta9ModelToken,
  });

  let dashboardActionBusy = false;
  const server = createServer(async (request, response) => {
    if (!authorized(request, options.token)) return json(response, 401, { error: 'unauthorized' });
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (request.method === 'POST' && pathname.startsWith('/api/beta8/')) {
      if (!actionRequestAllowed(request, host, allowActions)) return json(response, 403, { error: 'Beta.8 dashboard actions are disabled or not same-origin loopback' });
      if (dashboardActionBusy) return json(response, 409, { error: 'another dashboard action is already running' });
      dashboardActionBusy = true;
      try {
        const body = objectBody(await readJsonBody(request));
        if (pathname === '/api/beta8/discover') return json(response, 200, await beta8Actions.discover());
        if (pathname === '/api/beta8/answer') {
          const questionId = requiredString(body, 'questionId', 200);
          if (!['string', 'boolean'].includes(typeof body.value) && !Array.isArray(body.value)) throw new Error('value must be a string, string array, or boolean');
          if (Array.isArray(body.value) && !body.value.every((value) => typeof value === 'string')) throw new Error('multi-select value must be a string array');
          if (body.confirmed !== true) throw new Error('architecture answer requires confirmed=true');
          return json(response, 200, await beta8Actions.answer({ questionId, value: body.value as string | string[] | boolean, confirmed: true }));
        }
        if (pathname === '/api/beta8/blueprint') return json(response, 200, await beta8Actions.generateBlueprint());
        if (pathname === '/api/beta8/approve-task') {
          const itemId = requiredString(body, 'itemId', 120);
          const approvedBy = requiredString(body, 'approvedBy', 120);
          if (!Array.isArray(body.allowedPaths) || !body.allowedPaths.every((value) => typeof value === 'string')) throw new Error('allowedPaths must be a string array');
          return json(response, 200, await beta8Actions.approveTask(itemId, approvedBy, body.allowedPaths));
        }
        if (pathname === '/api/beta8/propose-task') return json(response, 200, await beta8Actions.proposeTask(requiredString(body, 'itemId', 120)));
        if (pathname === '/api/beta8/execute-task') {
          const itemId = requiredString(body, 'itemId', 120);
          const proposalHash = requiredString(body, 'proposalHash', 64);
          if (!/^[a-f0-9]{64}$/i.test(proposalHash)) throw new Error('proposalHash must be a sha256');
          if (body.confirmWrite !== true) throw new Error('execute-task requires confirmWrite=true');
          return json(response, 200, await beta8Actions.executeTask(itemId, proposalHash, true));
        }
        if (pathname === '/api/beta8/preview-acceptance') {
          if (!beta8Acceptance) throw new Error('Beta.8 target repository is not configured for acceptance');
          return json(response, 200, await beta8Acceptance.preview(requiredString(body, 'itemId', 120)));
        }
        if (pathname === '/api/beta8/accept-task') {
          if (!beta8Acceptance) throw new Error('Beta.8 target repository is not configured for acceptance');
          const itemId = requiredString(body, 'itemId', 120);
          const acceptanceHash = requiredString(body, 'acceptanceHash', 64);
          if (!/^[a-f0-9]{64}$/i.test(acceptanceHash)) throw new Error('acceptanceHash must be a sha256');
          return json(response, 200, await beta8Acceptance.accept(itemId, acceptanceHash, requiredString(body, 'acceptedBy', 120)));
        }
        if (pathname === '/api/beta8/mock-approve') {
          const recordId = requiredString(body, 'recordId', 120);
          const approvedBy = requiredString(body, 'approvedBy', 120);
          const action = requiredString(body, 'action', 80) as MockMigrationAction;
          if (!['retain', 'rewire-only', 'convert-to-seed', 'remove-after-live-verification'].includes(action)) throw new Error('invalid mock migration action');
          if (body.seedDestination !== undefined && typeof body.seedDestination !== 'string') throw new Error('seedDestination must be a string');
          if (body.removeSourceAfterSeed !== undefined && typeof body.removeSourceAfterSeed !== 'boolean') throw new Error('removeSourceAfterSeed must be boolean');
          return json(response, 200, await beta8MockMigration.approve({
            recordId, approvedBy, action,
            ...(typeof body.seedDestination === 'string' && body.seedDestination.trim() ? { seedDestination: body.seedDestination.trim() } : {}),
            removeSourceAfterSeed: body.removeSourceAfterSeed === true,
          }));
        }
        if (pathname === '/api/beta8/mock-verify-live') return json(response, 200, await beta8MockMigration.verifyLive(requiredString(body, 'recordId', 120), verificationCommand(body, 'command')!));
        if (pathname === '/api/beta8/mock-complete') return json(response, 200, await beta8MockMigration.completeNoMutation(requiredString(body, 'recordId', 120), verificationCommand(body, 'beta7Qa', false)));
        if (pathname === '/api/beta8/mock-propose') return json(response, 200, await beta8MockMigration.propose(requiredString(body, 'recordId', 120)));
        if (pathname === '/api/beta8/mock-execute') {
          const recordId = requiredString(body, 'recordId', 120);
          const proposalHash = requiredString(body, 'proposalHash', 64);
          if (!/^[a-f0-9]{64}$/i.test(proposalHash)) throw new Error('proposalHash must be a sha256');
          if (body.confirmWrite !== true) throw new Error('mock-execute requires confirmWrite=true');
          return json(response, 200, await beta8MockMigration.execute(recordId, proposalHash, true));
        }
        if (pathname === '/api/beta8/mock-preview-acceptance') {
          if (!beta8MockAcceptance) throw new Error('Beta.8 target repository is not configured for mock acceptance');
          return json(response, 200, await beta8MockAcceptance.preview(requiredString(body, 'recordId', 120)));
        }
        if (pathname === '/api/beta8/mock-accept') {
          if (!beta8MockAcceptance) throw new Error('Beta.8 target repository is not configured for mock acceptance');
          const recordId = requiredString(body, 'recordId', 120);
          const acceptanceHash = requiredString(body, 'acceptanceHash', 64);
          if (!/^[a-f0-9]{64}$/i.test(acceptanceHash)) throw new Error('acceptanceHash must be a sha256');
          return json(response, 200, await beta8MockAcceptance.accept(recordId, acceptanceHash, requiredString(body, 'acceptedBy', 120)));
        }
        if (pathname === '/api/beta8/run-final-qa') return json(response, 200, await beta8FinalQa.run(verificationCommand(body, 'command')!));
        if (pathname === '/api/beta8/send-findings-beta9') {
          if (!Array.isArray(body.fingerprints) || !body.fingerprints.every((value) => typeof value === 'string')) throw new Error('fingerprints must be a string array');
          if (body.project !== undefined && typeof body.project !== 'string') throw new Error('project must be a string');
          return json(response, 201, await beta8FinalQa.sendToBeta9(body.fingerprints, typeof body.project === 'string' ? body.project : undefined));
        }
        return json(response, 404, { error: 'unknown Beta.8 dashboard action' });
      } catch (error: unknown) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 1_000);
        return json(response, actionErrorStatus(message), { error: message });
      } finally { dashboardActionBusy = false; }
    }

    if (request.method === 'POST' && pathname.startsWith('/api/beta9/')) {
      if (!actionRequestAllowed(request, host, allowActions)) return json(response, 403, { error: 'Beta.9 dashboard actions are disabled or not same-origin loopback' });
      if (dashboardActionBusy) return json(response, 409, { error: 'another dashboard action is already running' });
      dashboardActionBusy = true;
      try {
        const body = objectBody(await readJsonBody(request));
        const sourceResultPath = await resolveBeta9SourceResult();
        if (pathname === '/api/beta9/select') {
          if (!sourceResultPath) return json(response, 409, { error: 'Beta.7 result path is not configured or available from Beta.8 final QA' });
          if (!Array.isArray(body.fingerprints) || !body.fingerprints.every((value) => typeof value === 'string')) throw new Error('fingerprints must be a string array');
          if (body.project !== undefined && typeof body.project !== 'string') throw new Error('project must be a string');
          return json(response, 201, await createBeta9SelectionFromDashboard({
            resultPath: sourceResultPath,
            planPath: beta9PlanPath,
            fingerprints: body.fingerprints,
            project: typeof body.project === 'string' ? body.project : undefined,
          }));
        }
        if (!sourceResultPath) return json(response, 409, { error: 'Beta.7 source result is not configured for Beta.9 actions' });
        const beta9Actions = new Beta9DashboardActionService(beta9ActionConfig(sourceResultPath));
        const itemId = requiredString(body, 'itemId', 120);
        if (pathname === '/api/beta9/plan') return json(response, 200, await beta9Actions.generateFixPlan(itemId));
        if (pathname === '/api/beta9/approve') return json(response, 200, await beta9Actions.approveFix(itemId, requiredString(body, 'planHash', 64), requiredString(body, 'approvedBy', 120)));
        if (pathname === '/api/beta9/execute') {
          const planHash = requiredString(body, 'planHash', 64);
          if (body.confirmWrite !== true) throw new Error('execute requires confirmWrite=true');
          return json(response, 200, await beta9Actions.executeFix(itemId, planHash, true));
        }
        if (pathname === '/api/beta9/correlate') {
          if (options.beta9PostResultPath) return json(response, 200, await beta9Actions.correlate(itemId));
          if (!options.beta9PostResultsRoot) throw new Error('fresh post-fix Beta.7 result is not configured and auto-discovery root is unavailable');
          const planSummary = await loadBeta9DashboardSummary(beta9PlanPath);
          if (!planSummary.available || !planSummary.sourceRunId) throw new Error('validated Beta.9 source run is not available for fresh-result discovery');
          const discovered = await discoverFreshBeta7Result({
            runsRoot: options.beta9PostResultsRoot,
            artifactRoot: beta9ArtifactRoot,
            sourceResultPath,
            sourceRunId: planSummary.sourceRunId,
            itemId,
          });
          return json(response, 200, await new Beta9DashboardActionService(beta9ActionConfig(sourceResultPath, discovered.path)).correlate(itemId));
        }
        if (pathname === '/api/beta9/prepare-retry') return json(response, 200, await beta9Actions.prepareRetry(itemId));
        return json(response, 404, { error: 'unknown Beta.9 dashboard action' });
      } catch (error: unknown) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 1_000);
        return json(response, actionErrorStatus(message), { error: message });
      } finally { dashboardActionBusy = false; }
    }

    if (!['GET', 'HEAD'].includes(request.method ?? '')) return json(response, 405, { error: 'dashboard mutation endpoint is not available' });
    const headOnly = request.method === 'HEAD';
    if (pathname === '/health') return json(response, 200, { ok: true });
    if (pathname === '/api/state') {
      try { return json(response, 200, await store.load()); } catch (error: unknown) { return json(response, 500, { error: String(error) }); }
    }
    if (pathname === '/api/beta8') {
      const [summary, acceptance, mockMigration, mockAcceptance, finalQa] = await Promise.all([
        beta8Actions.summary(),
        beta8Acceptance ? beta8Acceptance.summary() : Promise.resolve({ available: false, items: {} }),
        beta8MockMigration.summary(),
        beta8MockAcceptance ? beta8MockAcceptance.summary() : Promise.resolve({ available: false, items: {} }),
        beta8FinalQa.summary(),
      ]);
      return json(response, 200, {
        ...summary,
        acceptance,
        mockMigration: { ...mockMigration, acceptance: mockAcceptance },
        finalQa,
        actionsAllowed: actionRequestAllowed(request, host, allowActions),
      });
    }
    if (pathname === '/api/beta9') return json(response, 200, await loadBeta9DashboardSummary(beta9PlanPath));
    if (pathname === '/api/beta9/actions') {
      const sourceResultPath = await resolveBeta9SourceResult();
      if (!sourceResultPath) return json(response, 200, { available: false, busy: false, configuration: { repo: false, model: false, postResult: false }, items: {} });
      const summary = await new Beta9DashboardActionService(beta9ActionConfig(sourceResultPath)).summary();
      if (options.beta9PostResultsRoot && !options.beta9PostResultPath) summary.configuration.postResult = true;
      return json(response, 200, summary);
    }
    if (pathname === '/api/beta9/findings') {
      const sourceResultPath = await resolveBeta9SourceResult();
      if (!sourceResultPath) return json(response, 200, { available: false, actionsAllowed: false });
      const [source, plan] = await Promise.all([
        loadBeta9FindingSource(sourceResultPath, beta9PlanPath),
        loadBeta9DashboardSummary(beta9PlanPath),
      ]);
      return json(response, 200, { ...source, actionsAllowed: actionRequestAllowed(request, host, allowActions) && !plan.available });
    }
    if (pathname === '/dashboard.css') return text(response, 200, 'text/css; charset=utf-8', dashboardCss(), headOnly);
    if (pathname === '/beta8-dashboard.css') return text(response, 200, 'text/css; charset=utf-8', beta8DashboardCss(), headOnly);
    if (pathname === '/beta8-mock-dashboard.css') return text(response, 200, 'text/css; charset=utf-8', beta8MockDashboardCss(), headOnly);
    if (pathname === '/beta8-qa-dashboard.css') return text(response, 200, 'text/css; charset=utf-8', beta8QaDashboardCss(), headOnly);
    if (pathname === '/beta9-dashboard.css') return text(response, 200, 'text/css; charset=utf-8', beta9DashboardCss(), headOnly);
    if (pathname === '/dashboard.js') return text(response, 200, 'text/javascript; charset=utf-8', dashboardJs(), headOnly);
    if (pathname === '/beta8-dashboard.js') return text(response, 200, 'text/javascript; charset=utf-8', beta8DashboardJs(), headOnly);
    if (pathname === '/beta8-mock-dashboard.js') return text(response, 200, 'text/javascript; charset=utf-8', beta8MockDashboardJs(), headOnly);
    if (pathname === '/beta8-qa-dashboard.js') return text(response, 200, 'text/javascript; charset=utf-8', beta8QaDashboardJs(), headOnly);
    if (pathname === '/beta9-dashboard.js') return text(response, 200, 'text/javascript; charset=utf-8', beta9DashboardJs(), headOnly);
    if (pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      return response.end(headOnly ? '' : dashboardDocument());
    }
    return json(response, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, host, port: address.port };
}
