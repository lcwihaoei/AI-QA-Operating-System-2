import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { ControlPlaneStore } from './control-plane.js';

export interface DashboardServerOptions { host?: string; port?: number; token?: string; }
export function isLoopbackHost(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1'; }
function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true; const value = request.headers.authorization ?? ''; const expected = `Bearer ${token}`; const left = Buffer.from(value), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(body)); }
export function dashboardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI QA Control Plane</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0b1020;color:#e8ecf5}main{max-width:1200px;margin:auto;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.card{background:#151c30;border:1px solid #2a3554;border-radius:12px;padding:16px}table{width:100%;border-collapse:collapse;margin-top:18px}td,th{text-align:left;padding:9px;border-bottom:1px solid #29324a}.muted{color:#9eabc7}.good{color:#7de3a1}.bad{color:#ff9494}</style></head><body><main><h1>AI QA Control Plane</h1><p class="muted">Read-only operational view. No mutation controls are exposed by this dashboard.</p><div id="summary" class="grid"></div><table><thead><tr><th>Run</th><th>Coverage</th><th>UX</th><th>Opportunities</th><th>Critical/High</th><th>Visited</th><th>Finished</th></tr></thead><tbody id="runs"></tbody></table><script>async function refresh(){const r=await fetch('/api/state');if(!r.ok)return;const s=await r.json();const f=s.runs.reduce((n,x)=>n+x.findings.critical+x.findings.high,0);document.getElementById('summary').innerHTML=['Runs '+s.runs.length,'Workers '+s.workers.length,'Queued '+s.jobs.filter(j=>j.status==='queued').length,'High/Critical '+f].map(x=>'<div class="card">'+x+'</div>').join('');document.getElementById('runs').innerHTML=s.runs.slice().reverse().slice(0,100).map(x=>'<tr><td>'+esc(x.runId)+'</td><td>'+x.coverageScore.toFixed(1)+'</td><td>'+(x.uxScore==null?'—':x.uxScore.toFixed(1))+'</td><td>'+(x.uxOpportunities??'—')+'</td><td class="'+((x.findings.critical+x.findings.high)>0?'bad':'good')+'">'+(x.findings.critical+x.findings.high)+'</td><td>'+x.visited+'</td><td>'+esc(x.finishedAt)+'</td></tr>').join('')}function esc(x){return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}refresh();setInterval(refresh,5000)</script></main></body></html>`;
}
export async function startDashboard(store: ControlPlaneStore, options: DashboardServerOptions = {}) {
  const host = options.host ?? '127.0.0.1', port = options.port ?? 8787; if (!isLoopbackHost(host) && !options.token) throw new Error('remote dashboard binding requires a bearer token');
  const server = createServer(async (request, response) => {
    if (!authorized(request, options.token)) return json(response, 401, { error: 'unauthorized' }); if (!['GET', 'HEAD'].includes(request.method ?? '')) return json(response, 405, { error: 'read-only dashboard' });
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname; if (pathname === '/health') return json(response, 200, { ok: true });
    if (pathname === '/api/state') { try { return json(response, 200, await store.load()); } catch (error: unknown) { return json(response, 500, { error: String(error) }); } }
    if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }); return response.end(request.method === 'HEAD' ? '' : dashboardHtml()); }
    return json(response, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); const address = server.address() as AddressInfo; return { server, host, port: address.port };
}
