import { readFile } from 'node:fs/promises';
import { validateBeta9Plan, type Beta9Plan } from '../fix/beta9-planner.js';

const MAX_PLAN_BYTES = 10_000_000;

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

function bounded(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

export async function loadBeta9DashboardSummary(filePath = '.qa-beta9/plan.json'): Promise<Beta9DashboardSummary> {
  try {
    const buffer = await readFile(filePath);
    if (buffer.length > MAX_PLAN_BYTES) throw new Error('Beta.9 plan exceeds dashboard size limit');
    const plan = JSON.parse(buffer.toString('utf8')) as Beta9Plan;
    const validation = validateBeta9Plan(plan);
    if (!validation.valid) throw new Error('Beta.9 plan failed validation');
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
  host.innerHTML='<div class="card-heading"><div><h2>Beta.9 live state</h2><small>'+esc(data.project||'')+' · source '+esc(data.sourceRunId||'')+'</small></div><span class="chip">'+esc(data.selected||0)+' selected</span></div><div class="table-wrap"><table><thead><tr><th>Work item</th><th>Finding</th><th>Severity / kind</th><th>Status</th><th>Approval</th><th>Files / scope</th><th>Retry</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="empty-state">Mutation remains CLI/API approval-bound; this dashboard surface is intentionally read-only.</p>';
}
async function refreshBeta9(){try{const r=await fetch('/api/beta9',{headers:{accept:'application/json'},cache:'no-store'});if(!r.ok)throw new Error('beta9 '+r.status);render(await r.json())}catch(e){console.error('beta9 dashboard refresh failed',e)}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{refreshBeta9();setInterval(refreshBeta9,5000)});else{refreshBeta9();setInterval(refreshBeta9,5000)}
})();`;
}
