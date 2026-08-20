import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  beta9DashboardJs,
  createBeta9SelectionFromDashboard,
  loadBeta9DashboardSummary,
  loadBeta9FindingSource,
} from './beta9-dashboard.js';
import { ControlPlaneStore } from './control-plane.js';
import { dashboardCss, dashboardHtml, dashboardJs } from './dashboard-ui.js';

export { dashboardCss, dashboardHtml, dashboardJs } from './dashboard-ui.js';

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  token?: string;
  beta9PlanPath?: string;
  beta7ResultPath?: string;
  allowActions?: boolean;
}
export function isLoopbackHost(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1'; }

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

function actionRequestAllowed(request: IncomingMessage, host: string, allowActions: boolean): boolean {
  if (!isLoopbackHost(host) || !allowActions) return false;
  const site = request.headers['sec-fetch-site'];
  return typeof site !== 'string' || ['same-origin', 'same-site', 'none'].includes(site.toLowerCase());
}

function dashboardDocument(): string {
  return dashboardHtml().replace('</body>', '  <script src="/beta9-dashboard.js" defer></script>\n</body>');
}

export async function startDashboard(store: ControlPlaneStore, options: DashboardServerOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const beta9PlanPath = options.beta9PlanPath ?? '.qa-beta9/plan.json';
  const allowActions = options.allowActions === true;
  if (!isLoopbackHost(host) && !options.token) throw new Error('remote dashboard binding requires a bearer token');
  if (!isLoopbackHost(host) && allowActions) throw new Error('dashboard actions are loopback-only even when remote read access is authenticated');

  const server = createServer(async (request, response) => {
    if (!authorized(request, options.token)) return json(response, 401, { error: 'unauthorized' });
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (request.method === 'POST' && pathname === '/api/beta9/select') {
      if (!actionRequestAllowed(request, host, allowActions)) return json(response, 403, { error: 'Beta.9 dashboard selection actions are disabled or not same-origin loopback' });
      if (!options.beta7ResultPath) return json(response, 409, { error: 'Beta.7 result path is not configured' });
      try {
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('selection body must be a JSON object');
        const record = body as Record<string, unknown>;
        if (!Array.isArray(record.fingerprints) || !record.fingerprints.every((value) => typeof value === 'string')) throw new Error('fingerprints must be a string array');
        if (record.project !== undefined && typeof record.project !== 'string') throw new Error('project must be a string');
        const summary = await createBeta9SelectionFromDashboard({
          resultPath: options.beta7ResultPath,
          planPath: beta9PlanPath,
          fingerprints: record.fingerprints,
          project: typeof record.project === 'string' ? record.project : undefined,
        });
        return json(response, 201, summary);
      } catch (error: unknown) {
        const message = String(error instanceof Error ? error.message : error);
        return json(response, /already exists/i.test(message) ? 409 : 400, { error: message.slice(0, 1_000) });
      }
    }

    if (!['GET', 'HEAD'].includes(request.method ?? '')) return json(response, 405, { error: 'dashboard mutation endpoint is not available' });
    const headOnly = request.method === 'HEAD';
    if (pathname === '/health') return json(response, 200, { ok: true });
    if (pathname === '/api/state') {
      try {
        return json(response, 200, await store.load());
      } catch (error: unknown) {
        return json(response, 500, { error: String(error) });
      }
    }
    if (pathname === '/api/beta9') return json(response, 200, await loadBeta9DashboardSummary(beta9PlanPath));
    if (pathname === '/api/beta9/findings') {
      if (!options.beta7ResultPath) return json(response, 200, { available: false, actionsAllowed: false });
      const [source, plan] = await Promise.all([
        loadBeta9FindingSource(options.beta7ResultPath, beta9PlanPath),
        loadBeta9DashboardSummary(beta9PlanPath),
      ]);
      return json(response, 200, { ...source, actionsAllowed: actionRequestAllowed(request, host, allowActions) && !plan.available });
    }
    if (pathname === '/dashboard.css') return text(response, 200, 'text/css; charset=utf-8', dashboardCss(), headOnly);
    if (pathname === '/dashboard.js') return text(response, 200, 'text/javascript; charset=utf-8', dashboardJs(), headOnly);
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
