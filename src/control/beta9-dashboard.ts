import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { QaRunResult } from '../core/types.js';
import { buildBeta9Plan, validateBeta9Plan, type Beta9Plan } from '../fix/beta9-planner.js';

const MAX_PLAN_BYTES = 10_000_000;
const MAX_RESULT_BYTES = 50_000_000;
const findingSchema = z.object({
  id: z.string().max(500),
  kind: z.enum(['console', 'page-error', 'network', 'ui', 'navigation', 'assertion']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string().max(5_000),
  url: z.string().max(10_000),
  message: z.string().max(20_000),
  reproduction: z.array(z.string().max(5_000)).max(500),
  evidence: z.array(z.string().max(5_000)).max(2_000),
  fingerprint: z.string().min(1).max(500),
});
const qaResultSchema = z.object({ runId: z.string().min(1).max(500), findings: z.array(findingSchema).max(20_000) });

export interface Beta9DashboardItem {
  id: string;
  title: string;
  severity: string;
  kind: string;
  url: string;
  status: string;
  priority: string;
  confidence: number;
  approved: boolean;
  mutationAllowed: boolean;
  affectedFiles: number;
  allowedPaths: number;
  retry?: { previousAttempt: number; nextAttempt: number; postRunId: string; authorizationHash: string };
}

export interface Beta9DashboardSummary {
  available: boolean;
  project?: string;
  sourceRunId?: string;
  selected?: number;
  statuses?: Record<string, number>;
  items?: Beta9DashboardItem[];
  error?: string;
}

export interface Beta9DashboardFinding {
  fingerprint: string;
  severity: string;
  kind: string;
  title: string;
  url: string;
  selected: boolean;
}

export interface Beta9DashboardFindingSource {
  available: boolean;
  runId?: string;
  total?: number;
  findings?: Beta9DashboardFinding[];
  error?: string;
}

function bounded(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

async function readPlan(filePath: string): Promise<Beta9Plan> {
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_PLAN_BYTES) throw new Error('Beta.9 plan exceeds dashboard size limit');
  const plan = JSON.parse(buffer.toString('utf8')) as Beta9Plan;
  const validation = validateBeta9Plan(plan);
  if (!validation.valid) throw new Error('Beta.9 plan failed validation');
  return plan;
}

async function readResult(filePath: string): Promise<Pick<QaRunResult, 'runId' | 'findings'>> {
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_RESULT_BYTES) throw new Error('Beta.7 result exceeds dashboard size limit');
  return qaResultSchema.parse(JSON.parse(buffer.toString('utf8'))) as unknown as Pick<QaRunResult, 'runId' | 'findings'>;
}

export async function loadBeta9DashboardSummary(filePath = '.qa-beta9/plan.json'): Promise<Beta9DashboardSummary> {
  try {
    const plan = await readPlan(filePath);
    const selectedByItem = new Map(plan.selectedFindings.map((entry) => [entry.workItemId, entry.finding]));
    const statuses: Record<string, number> = {};
    const items: Beta9DashboardItem[] = plan.workPlan.items.slice(0, 500).map((item) => {
      statuses[item.status] = (statuses[item.status] ?? 0) + 1;
      const finding = selectedByItem.get(item.id);
      const retry = plan.retryAuthorizations?.[item.id];
      return {
        id: bounded(item.id, 120),
        title: bounded(item.title, 300),
        severity: bounded(finding?.severity, 20),
        kind: bounded(finding?.kind, 30),
        url: bounded(finding?.url, 1_000),
        status: bounded(item.status, 40),
        priority: bounded(item.priority, 10),
        confidence: Number.isFinite(item.confidence) ? item.confidence : 0,
        approved: Boolean(item.approval.approved),
        mutationAllowed: Boolean(item.execution.mutationAllowed),
        affectedFiles: item.affectedFiles.length,
        allowedPaths: item.execution.allowedPaths.length,
        ...(retry ? { retry: {
          previousAttempt: retry.previousAttempt,
          nextAttempt: retry.nextAttempt,
          postRunId: bounded(retry.postRunId, 500),
          authorizationHash: bounded(retry.authorizationHash, 64),
        } } : {}),
      };
    });
    return {
      available: true,
      project: bounded(plan.project, 200),
      sourceRunId: bounded(plan.sourceRunId, 500),
      selected: plan.selectedFindings.length,
      statuses,
      items,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { available: false };
    return { available: false, error: 'Beta.9 plan is unavailable or invalid' };
  }
}

export async function loadBeta9FindingSource(resultPath: string, planPath = '.qa-beta9/plan.json'): Promise<Beta9DashboardFindingSource> {
  try {
    const result = await readResult(resultPath);
    let selected = new Set<string>();
    try {
      const plan = await readPlan(planPath);
      if (plan.sourceRunId === result.runId) selected = new Set(plan.selectedFindings.map((entry) => entry.finding.fingerprint));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    return {
      available: true,
      runId: bounded(result.runId, 500),
      total: result.findings.length,
      findings: result.findings.slice(0, 2_000).map((finding) => ({
        fingerprint: bounded(finding.fingerprint, 500),
        severity: bounded(finding.severity, 20),
        kind: bounded(finding.kind, 30),
        title: bounded(finding.title, 500),
        url: bounded(finding.url, 2_000),
        selected: selected.has(finding.fingerprint),
      })),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { available: false };
    return { available: false, error: 'Beta.7 finding source is unavailable or invalid' };
  }
}

export async function createBeta9SelectionFromDashboard(input: {
  resultPath: string;
  planPath: string;
  fingerprints: string[];
  project?: string;
}): Promise<Beta9DashboardSummary> {
  const result = await readResult(input.resultPath);
  const fingerprints = input.fingerprints.map((value) => bounded(value, 500)).filter(Boolean);
  if (fingerprints.length === 0 || fingerprints.length > 200) throw new Error('dashboard selection requires 1-200 finding fingerprints');
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error('dashboard selection contains duplicate finding fingerprints');
  const plan = buildBeta9Plan({ result: result as QaRunResult, selectedFingerprints: fingerprints, project: bounded(input.project ?? 'Dashboard Beta.9 selection', 200) });
  const absolute = path.resolve(input.planPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error('Beta.9 plan already exists; refusing to overwrite active review/approval state');
    throw error;
  }
  return loadBeta9DashboardSummary(absolute);
}

export function beta9DashboardJs(): string {
  return `(()=>{
'use strict';
function esc(v){return String(v==null?'':v).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));}
function count(s,k){return Number(s&&s[k]||0)}
function render(data){
  const metric=document.getElementById('metricFixes');if(metric)metric.textContent=String(data.available?Number(data.selected||0):0);
  const panel=document.querySelector('.auto-fix-panel .status-grid');
  if(panel){const s=data.statuses||{};const queued=count(s,'planned')+count(s,'approved');const running=count(s,'in-progress');const review=count(s,'verification')+count(s,'blocked');const done=count(s,'completed');panel.innerHTML='<div class="status-card orange-outline"><span>Queued</span><strong>'+queued+'</strong></div><div class="status-card blue-outline"><span>Running</span><strong>'+running+'</strong></div><div class="status-card purple-outline"><span>Review</span><strong>'+review+'</strong></div><div class="status-card green-outline"><span>Completed</span><strong>'+done+'</strong></div>';}
  const page=document.querySelector('[data-page="beta9"]');if(!page)return;
  let host=document.getElementById('beta9LiveState');if(!host){host=document.createElement('article');host.id='beta9LiveState';host.className='panel';page.appendChild(host);}
  if(!data.available){host.innerHTML='<div class="card-heading"><h2>Beta.9 live state</h2><span class="chip">Read only</span></div><p class="empty-state">No validated .qa-beta9 plan is available yet.</p>';return;}
  const rows=(data.items||[]).map(i=>'<tr><td><strong>'+esc(i.id)+'</strong></td><td>'+esc(i.title)+'</td><td>'+esc(i.severity||'—')+' / '+esc(i.kind||'—')+'</td><td><span class="status-pill '+esc(i.status)+'">'+esc(i.status)+'</span></td><td>'+esc(i.approved?'approved':'not approved')+'</td><td>'+esc(i.affectedFiles)+' / '+esc(i.allowedPaths)+'</td><td>'+(i.retry?'attempt '+esc(i.retry.nextAttempt)+' after '+esc(i.retry.postRunId):'—')+'</td></tr>').join('');
  host.innerHTML='<div class="card-heading"><div><h2>Beta.9 live state</h2><small>'+esc(data.project||'')+' · source '+esc(data.sourceRunId||'')+'</small></div><span class="chip">'+esc(data.selected||0)+' selected</span></div><div class="table-wrap"><table><thead><tr><th>Work item</th><th>Finding</th><th>Severity / kind</th><th>Status</th><th>Approval</th><th>Files / scope</th><th>Retry</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="empty-state">Repository mutation remains separately plan/scope/hash approval-bound.</p>';
}
function renderCandidates(data){
  const page=document.querySelector('[data-page="beta9"]');if(!page)return;
  let host=document.getElementById('beta9FindingSource');if(!host){host=document.createElement('article');host.id='beta9FindingSource';host.className='panel';page.insertBefore(host,page.querySelector('#beta9LiveState'));}
  if(!data.available){host.innerHTML='<div class="card-heading"><h2>Beta.7 finding source</h2><span class="chip">Unavailable</span></div><p class="empty-state">Configure a Beta.7 result file to select findings here.</p>';return;}
  const rows=(data.findings||[]).map(f=>'<tr><td><input type="checkbox" data-beta9-fingerprint="'+esc(f.fingerprint)+'" '+(f.selected?'checked disabled':'')+' '+(data.actionsAllowed?'':'disabled')+'></td><td><strong>'+esc(f.title)+'</strong></td><td>'+esc(f.severity)+' / '+esc(f.kind)+'</td><td>'+esc(f.url)+'</td></tr>').join('');
  host.innerHTML='<div class="card-heading"><div><h2>Beta.7 finding source</h2><small>'+esc(data.runId||'')+' · '+esc(data.total||0)+' findings</small></div><span class="chip">'+(data.actionsAllowed?'Local selection enabled':'Read only')+'</span></div><div class="table-wrap"><table><thead><tr><th>Select</th><th>Finding</th><th>Severity / kind</th><th>Route</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+(data.actionsAllowed?'<button id="beta9CreateSelection" class="primary-button">Create Beta.9 selection plan</button>':'<p class="empty-state">Start the loopback dashboard with --allow-actions to create a new selection plan. Source-code mutation is not enabled by this control.</p>');
  const button=document.getElementById('beta9CreateSelection');if(button)button.addEventListener('click',createSelection);
}
async function createSelection(){
  const fingerprints=Array.from(document.querySelectorAll('[data-beta9-fingerprint]:checked:not(:disabled)')).map(el=>el.getAttribute('data-beta9-fingerprint')).filter(Boolean);
  if(!fingerprints.length){window.alert('Select at least one finding.');return;}
  if(!window.confirm('Create a Beta.9 review plan for '+fingerprints.length+' selected finding(s)? This does not modify source code.'))return;
  const response=await fetch('/api/beta9/select',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({fingerprints})});
  const body=await response.json();if(!response.ok){window.alert(body.error||'Selection failed');return;}await refreshBeta9();await refreshCandidates();
}
async function refreshBeta9(){try{const r=await fetch('/api/beta9',{headers:{accept:'application/json'},cache:'no-store'});if(!r.ok)throw new Error('beta9 '+r.status);render(await r.json())}catch(e){console.error('beta9 dashboard refresh failed',e)}}
async function refreshCandidates(){try{const r=await fetch('/api/beta9/findings',{headers:{accept:'application/json'},cache:'no-store'});if(!r.ok)throw new Error('beta9 findings '+r.status);renderCandidates(await r.json())}catch(e){console.error('beta9 finding source refresh failed',e)}}
function start(){refreshBeta9();refreshCandidates();setInterval(refreshBeta9,5000);setInterval(refreshCandidates,10000)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();`;
}
