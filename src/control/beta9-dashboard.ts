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
let lastSummary=null,lastCandidates=null,lastActions=null,actionPending=false;
function esc(v){return String(v==null?'':v).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));}
function zh(){return (document.documentElement.lang||'').toLowerCase()==='zh-tw'}
function L(en,tc){return zh()?tc:en}
function count(s,k){return Number(s&&s[k]||0)}
function statusLabel(v){const map={planned:['Planned','已規劃'],approved:['Approved','已核准'],'in-progress':['Running','執行中'],verification:['Verification','待驗證'],blocked:['Blocked','受阻'],completed:['Completed','已完成'],rejected:['Rejected','已拒絕'],'retry-ready':['Retry ready','重試就緒'],'awaiting-correlation':['Awaiting correlation','等待比對'],correlated:['Correlated','已比對'],planning:['Planning','規劃中'],executing:['Executing','執行中'],error:['Error','錯誤']};return map[v]?L(map[v][0],map[v][1]):v}
function button(label,action,id,extra){return '<button class="'+(extra||'secondary-button')+'" data-b9-action="'+esc(action)+'" data-b9-item="'+esc(id)+'">'+esc(label)+'</button>'}
function renderSummary(data){
  lastSummary=data;
  const metric=document.getElementById('metricFixes');if(metric)metric.textContent=String(data.available?Number(data.selected||0):0);
  const panel=document.querySelector('.auto-fix-panel .status-grid');
  if(panel){const s=data.statuses||{};const queued=count(s,'planned')+count(s,'approved');const running=count(s,'in-progress');const review=count(s,'verification')+count(s,'blocked');const done=count(s,'completed');panel.innerHTML='<div class="status-card orange-outline"><span>'+esc(L('Queued','排隊中'))+'</span><strong>'+queued+'</strong></div><div class="status-card blue-outline"><span>'+esc(L('Running','執行中'))+'</span><strong>'+running+'</strong></div><div class="status-card purple-outline"><span>'+esc(L('Review','待確認'))+'</span><strong>'+review+'</strong></div><div class="status-card green-outline"><span>'+esc(L('Completed','已完成'))+'</span><strong>'+done+'</strong></div>';}
  const page=document.querySelector('[data-page="beta9"]');if(!page)return;
  let host=document.getElementById('beta9LiveState');if(!host){host=document.createElement('article');host.id='beta9LiveState';host.className='panel';page.appendChild(host);}
  if(!data.available){host.innerHTML='<div class="card-heading"><h2>'+esc(L('Beta.9 live state','Beta.9 即時狀態'))+'</h2><span class="chip">'+esc(L('Read only','唯讀'))+'</span></div><p class="empty-state">'+esc(L('No validated Beta.9 plan is available yet.','目前沒有可用且通過驗證的 Beta.9 計畫。'))+'</p>';return;}
  const rows=(data.items||[]).map(i=>'<tr><td><strong>'+esc(i.id)+'</strong></td><td>'+esc(i.title)+'</td><td>'+esc(i.severity||'—')+' / '+esc(i.kind||'—')+'</td><td><span class="status-pill '+esc(i.status)+'">'+esc(statusLabel(i.status))+'</span></td><td>'+esc(i.approved?L('Approved','已核准'):L('Not approved','未核准'))+'</td><td>'+esc(i.affectedFiles)+' / '+esc(i.allowedPaths)+'</td><td>'+(i.retry?esc(L('Attempt ','第 ')+i.retry.nextAttempt+L(' after ',' 次；依據 ')+i.retry.postRunId):'—')+'</td></tr>').join('');
  host.innerHTML='<div class="card-heading"><div><h2>'+esc(L('Beta.9 live state','Beta.9 即時狀態'))+'</h2><small>'+esc(data.project||'')+' · '+esc(L('source ','來源 '))+esc(data.sourceRunId||'')+'</small></div><span class="chip">'+esc(data.selected||0)+' '+esc(L('selected','已選'))+'</span></div><div class="table-wrap"><table><thead><tr><th>'+esc(L('Work item','工作項目'))+'</th><th>'+esc(L('Finding','問題'))+'</th><th>'+esc(L('Severity / kind','嚴重度 / 類型'))+'</th><th>'+esc(L('Status','狀態'))+'</th><th>'+esc(L('Approval','核准'))+'</th><th>'+esc(L('Files / scope','檔案 / 範圍'))+'</th><th>'+esc(L('Retry','重試'))+'</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="empty-state">'+esc(L('Repository mutation remains separately plan/scope/hash approval-bound.','程式碼修改仍受計畫、範圍與雜湊的獨立核准機制約束。'))+'</p>';
}
function renderCandidates(data){
  lastCandidates=data;
  const page=document.querySelector('[data-page="beta9"]');if(!page)return;
  let host=document.getElementById('beta9FindingSource');if(!host){host=document.createElement('article');host.id='beta9FindingSource';host.className='panel';page.insertBefore(host,page.querySelector('#beta9LiveState'));}
  if(!data.available){host.innerHTML='<div class="card-heading"><h2>'+esc(L('Beta.7 finding source','Beta.7 問題來源'))+'</h2><span class="chip">'+esc(L('Unavailable','不可用'))+'</span></div><p class="empty-state">'+esc(L('Configure a Beta.7 result file to select findings here.','請設定 Beta.7 result 檔案後再由此選擇問題。'))+'</p>';return;}
  const rows=(data.findings||[]).map(f=>'<tr><td><input type="checkbox" data-beta9-fingerprint="'+esc(f.fingerprint)+'" '+(f.selected?'checked disabled':'')+' '+(data.actionsAllowed?'':'disabled')+'></td><td><strong>'+esc(f.title)+'</strong></td><td>'+esc(f.severity)+' / '+esc(f.kind)+'</td><td>'+esc(f.url)+'</td></tr>').join('');
  host.innerHTML='<div class="card-heading"><div><h2>'+esc(L('Beta.7 finding source','Beta.7 問題來源'))+'</h2><small>'+esc(data.runId||'')+' · '+esc(data.total||0)+' '+esc(L('findings','個問題'))+'</small></div><span class="chip">'+esc(data.actionsAllowed?L('Local selection enabled','本機選擇已啟用'):L('Read only','唯讀'))+'</span></div><div class="table-wrap"><table><thead><tr><th>'+esc(L('Select','選擇'))+'</th><th>'+esc(L('Finding','問題'))+'</th><th>'+esc(L('Severity / kind','嚴重度 / 類型'))+'</th><th>'+esc(L('Route','路由'))+'</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+(data.actionsAllowed?'<button id="beta9CreateSelection" class="primary-button">'+esc(L('Create Beta.9 selection plan','建立 Beta.9 選擇計畫'))+'</button>':'<p class="empty-state">'+esc(L('Start the loopback dashboard with --allow-actions to create a new selection plan.','使用 --allow-actions 啟動本機管理面板後，才可建立新的選擇計畫。'))+'</p>');
  const create=document.getElementById('beta9CreateSelection');if(create)create.addEventListener('click',createSelection);
}
function planDetails(a){const p=a&&a.plan;if(!p)return '';const changes=(p.changes||[]).map(c=>'<li><strong>'+esc(c.operation)+'</strong> '+esc(c.path)+'</li>').join('');const steps=(p.recommendedChange||[]).map(v=>'<li>'+esc(v)+'</li>').join('');const risks=(p.regressionRisk||[]).map(v=>'<li>'+esc(v)+'</li>').join('')||'<li>—</li>';const tests=(p.targetedTests||[]).map(v=>'<li>'+esc(v)+'</li>').join('');return '<div class="decision-grid"><div><b>'+esc(L('Root cause','根因'))+'</b><span>'+esc(p.rootCause)+'</span></div><div><b>'+esc(L('Confidence','信心值'))+'</b><span>'+esc(Math.round(Number(p.confidence||0)*100))+'%</span></div><div><b>'+esc(L('Plan hash','計畫雜湊'))+'</b><span>'+esc(p.planHash)+'</span></div><div><b>'+esc(L('Attempt','嘗試次數'))+'</b><span>'+esc(p.attempt)+'</span></div></div><div class="decision-grid"><div><b>'+esc(L('Reviewed changes','已審閱修改'))+'</b><ul>'+changes+'</ul></div><div><b>'+esc(L('Recommended steps','建議步驟'))+'</b><ol>'+steps+'</ol></div><div><b>'+esc(L('Regression risks','回歸風險'))+'</b><ul>'+risks+'</ul></div><div><b>'+esc(L('Verification','驗證'))+'</b><ul>'+tests+'<li>'+esc(p.regression)+'</li><li>'+esc(p.beta7Qa)+'</li></ul></div></div>'}
function actionControls(item,a,config,busy){
  if(busy)return '<span class="chip">'+esc(L('Another action is running','另一個動作執行中'))+'</span>';
  const phase=(a&&a.phase)||item.status;
  if(item.status==='completed'||phase==='completed')return '<span class="chip">'+esc(L('Resolved and verified','已修復並驗證'))+'</span>';
  if((item.status==='planned'||phase==='retry-ready'||phase==='error')&&!(a&&a.plan)){
    const ready=config&&config.repo&&config.model;return ready?button(L('Generate fix plan','產生修復方案'),'plan',item.id,'primary-button'):'<span class="chip">'+esc(L('Configure repository + model endpoint','請設定 repository 與模型端點'))+'</span>';
  }
  if(item.status==='planned'&&a&&a.plan)return button(L('Approve exact reviewed files','核准已審閱的精確檔案'),'approve',item.id,'primary-button');
  if(item.status==='approved'&&a&&a.plan)return button(L('Execute approved fix','執行已核准修復'),'execute',item.id,'primary-button');
  if((item.status==='verification'||phase==='awaiting-correlation')&&a&&a.attempt)return config&&config.postResult?button(L('Correlate fresh Beta.7 result','比對最新 Beta.7 結果'),'correlate',item.id,'primary-button'):'<span class="chip">'+esc(L('Configure fresh post-fix Beta.7 result','請設定修復後的 Beta.7 result'))+'</span>';
  if((item.status==='blocked'||phase==='correlated')&&a&&a.correlation&&a.correlation.retryEligible)return button(L('Prepare bounded retry','準備受控重試'),'retry',item.id,'primary-button');
  return '<span class="chip">'+esc(statusLabel(phase))+'</span>';
}
function renderActions(data){
  lastActions=data;
  const page=document.querySelector('[data-page="beta9"]');if(!page)return;
  let host=document.getElementById('beta9ActionCenter');if(!host){host=document.createElement('article');host.id='beta9ActionCenter';host.className='panel';const live=document.getElementById('beta9LiveState');page.insertBefore(host,live||null);}
  if(!lastSummary||!lastSummary.available){host.innerHTML='<div class="card-heading"><h2>'+esc(L('AI fix control center','AI 修復控制中心'))+'</h2><span class="chip">Beta.9</span></div><p class="empty-state">'+esc(L('Create a Beta.9 selection plan first.','請先建立 Beta.9 選擇計畫。'))+'</p>';return;}
  if(!data.available){host.innerHTML='<div class="card-heading"><h2>'+esc(L('AI fix control center','AI 修復控制中心'))+'</h2><span class="chip">'+esc(L('Unavailable','不可用'))+'</span></div><p class="empty-state">'+esc(data.error||L('Action state is unavailable.','動作狀態不可用。'))+'</p>';return;}
  const cards=(lastSummary.items||[]).map(item=>{const a=(data.items||{})[item.id]||{};const corr=a.correlation;const msg=a.message?'<p>'+esc(a.message)+'</p>':'';const correlation=corr?'<div class="decision-grid"><div><b>'+esc(L('Post-QA status','QA 後狀態'))+'</b><span>'+esc(statusLabel(corr.status))+'</span></div><div><b>'+esc(L('New findings','新增問題'))+'</b><span>'+esc(corr.newFindingCount)+'</span></div><div><b>'+esc(L('New critical/high','新增 Critical/High'))+'</b><span>'+esc((corr.newCriticalHigh||[]).length)+'</span></div><div><b>'+esc(L('Retry eligible','允許重試'))+'</b><span>'+esc(corr.retryEligible?L('Yes','是'):L('No','否'))+'</span></div></div>':'';return '<section class="panel"><div class="card-heading"><div><h2>'+esc(item.title)+'</h2><small>'+esc(item.id)+' · '+esc(item.severity)+' / '+esc(item.kind)+'</small></div><span class="status-pill '+esc(item.status)+'">'+esc(statusLabel((a&&a.phase)||item.status))+'</span></div>'+msg+planDetails(a)+correlation+'<div class="pipeline-toolbar">'+actionControls(item,a,data.configuration,data.busy||actionPending)+'</div></section>'}).join('');
  host.innerHTML='<div class="card-heading"><div><h2>'+esc(L('AI fix control center','AI 修復控制中心'))+'</h2><small>'+esc(L('Review plan → approve exact files → execute → correlate → retry only when eligible','審閱方案 → 核准精確檔案 → 執行 → 比對 → 僅在符合條件時重試'))+'</small></div><span class="chip">'+esc(data.busy?L('Busy','忙碌中'):L('Governed','受控模式'))+'</span></div>'+cards;
  host.querySelectorAll('[data-b9-action]').forEach(el=>el.addEventListener('click',()=>runAction(el.getAttribute('data-b9-action'),el.getAttribute('data-b9-item'))));
}
async function post(endpoint,payload){const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify(payload)});const body=await response.json();if(!response.ok)throw new Error(body.error||('HTTP '+response.status));return body}
async function runAction(action,itemId){
  if(actionPending||!itemId)return;const a=lastActions&&lastActions.items&&lastActions.items[itemId]||{};actionPending=true;renderActions(lastActions||{available:false,items:{},configuration:{}});
  try{
    if(action==='plan')await post('/api/beta9/plan',{itemId});
    else if(action==='approve'){
      if(!a.plan)throw new Error(L('No reviewed plan is available.','沒有可審閱的修復方案。'));const who=window.prompt(L('Approver name','核准者名稱'),'owner');if(!who)return;await post('/api/beta9/approve',{itemId,planHash:a.plan.planHash,approvedBy:who});
    }else if(action==='execute'){
      if(!a.plan)throw new Error(L('No approved plan is available.','沒有已核准的修復方案。'));const tail=a.plan.planHash.slice(-8);const typed=window.prompt(L('This action can modify source files in the isolated branch. Type the last 8 characters of the reviewed plan hash to continue: ','此動作會在隔離分支修改程式碼。請輸入已審閱 plan hash 的最後 8 碼以繼續：')+tail,'');if(typed!==tail)return;await post('/api/beta9/execute',{itemId,planHash:a.plan.planHash,confirmWrite:true});
    }else if(action==='correlate'){
      if(!window.confirm(L('Compare the fresh Beta.7 result with the original run now?','現在要將最新 Beta.7 結果與原始結果進行比對嗎？')))return;await post('/api/beta9/correlate',{itemId});
    }else if(action==='retry'){
      if(!window.confirm(L('Prepare a bounded retry? The unresolved isolated changes will be rolled back and a completely new plan will be required.','準備受控重試嗎？未解決的隔離變更將被回滾，且必須重新產生並核准新的方案。')))return;await post('/api/beta9/prepare-retry',{itemId});
    }
  }catch(e){window.alert(String(e&&e.message||e));}finally{actionPending=false;await refreshAllBeta9();}
}
async function createSelection(){
  const fingerprints=Array.from(document.querySelectorAll('[data-beta9-fingerprint]:checked:not(:disabled)')).map(el=>el.getAttribute('data-beta9-fingerprint')).filter(Boolean);
  if(!fingerprints.length){window.alert(L('Select at least one finding.','請至少選擇一個問題。'));return;}
  if(!window.confirm(L('Create a Beta.9 review plan for ','要為 ')+fingerprints.length+L(' selected finding(s)? This does not modify source code.',' 個已選問題建立 Beta.9 審閱計畫嗎？這一步不會修改程式碼。')))return;
  try{await post('/api/beta9/select',{fingerprints});await refreshAllBeta9();}catch(e){window.alert(String(e&&e.message||e));}
}
async function refreshSummary(){try{const r=await fetch('/api/beta9',{headers:{accept:'application/json'},cache:'no-store'});if(!r.ok)throw new Error('beta9 '+r.status);renderSummary(await r.json())}catch(e){console.error('beta9 dashboard refresh failed',e)}}
async function refreshCandidates(){try{const r=await fetch('/api/beta9/findings',{headers:{accept:'application/json'},cache:'no-store'});if(!r.ok)throw new Error('beta9 findings '+r.status);renderCandidates(await r.json())}catch(e){console.error('beta9 finding source refresh failed',e)}}
async function refreshActions(){try{const r=await fetch('/api/beta9/actions',{headers:{accept:'application/json'},cache:'no-store'});if(!r.ok)throw new Error('beta9 actions '+r.status);renderActions(await r.json())}catch(e){console.error('beta9 action state refresh failed',e)}}
async function refreshAllBeta9(){await refreshSummary();await Promise.all([refreshCandidates(),refreshActions()])}
function rerender(){if(lastSummary)renderSummary(lastSummary);if(lastCandidates)renderCandidates(lastCandidates);if(lastActions)renderActions(lastActions)}
function start(){refreshAllBeta9();setInterval(refreshSummary,5000);setInterval(refreshActions,5000);setInterval(refreshCandidates,10000);new MutationObserver(rerender).observe(document.documentElement,{attributes:true,attributeFilter:['lang']})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();`;
}
