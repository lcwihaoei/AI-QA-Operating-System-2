import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ControlPlaneStore } from './control-plane.js';
import { dashboardCss, dashboardHtml, dashboardJs } from './dashboard-ui.js';

export { dashboardCss, dashboardHtml, dashboardJs } from './dashboard-ui.js';

export interface DashboardServerOptions { host?: string; port?: number; token?: string; }
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

export async function startDashboard(store: ControlPlaneStore, options: DashboardServerOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  if (!isLoopbackHost(host) && !options.token) throw new Error('remote dashboard binding requires a bearer token');

  const server = createServer(async (request, response) => {
    if (!authorized(request, options.token)) return json(response, 401, { error: 'unauthorized' });
    if (!['GET', 'HEAD'].includes(request.method ?? '')) return json(response, 405, { error: 'read-only dashboard' });

    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const headOnly = request.method === 'HEAD';
    if (pathname === '/health') return json(response, 200, { ok: true });
    if (pathname === '/api/state') {
      try {
        return json(response, 200, await store.load());
      } catch (error: unknown) {
        return json(response, 500, { error: String(error) });
      }
    }
    if (pathname === '/dashboard.css') return text(response, 200, 'text/css; charset=utf-8', dashboardCss(), headOnly);
    if (pathname === '/dashboard.js') return text(response, 200, 'text/javascript; charset=utf-8', dashboardJs(), headOnly);
    if (pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      return response.end(headOnly ? '' : dashboardHtml());
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
