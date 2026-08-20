#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { z } from 'zod';
import type { Finding, QaRunResult } from './core/types.js';
import { LocalGitBackendWorkspace } from './backend/local-git-backend-workspace.js';
import { pathAllowedForWorkItem } from './backend/backend-executor.js';
import { approveWorkItem } from './planning/work-item.js';
import { Beta9FixExecutor } from './fix/beta9-executor.js';
import {
  applyBeta9Correlation,
  correlateBeta9Attempt,
  prepareBeta9Retry,
  validateBeta9CorrelationReport,
  type Beta9AttemptEvidence,
  type Beta9CorrelationReport,
} from './fix/beta9-correlation.js';
import { Beta9FixPlanner, validateBeta9FixPlan, type Beta9FixPlan } from './fix/beta9-fix-plan.js';
import { buildBeta9Plan, selectedFindingForItem, validateBeta9Plan, type Beta9Plan } from './fix/beta9-planner.js';
import { LocalGitFixWorkspace } from './fix/local-git-fix-workspace.js';
import { HttpBeta9FixModel } from './providers/http-beta9-fix-model.js';

const findingSchema = z.object({
  id: z.string(),
  kind: z.enum(['console', 'page-error', 'network', 'ui', 'navigation', 'assertion']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string(),
  url: z.string(),
  message: z.string(),
  reproduction: z.array(z.string()).max(500),
  evidence: z.array(z.string()).max(2_000),
  fingerprint: z.string(),
});
const resultSelectionSchema = z.object({ runId: z.string().min(1).max(500), findings: z.array(findingSchema).max(20_000) });

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8')) as T;
}

async function readQaResult(filePath: string): Promise<Pick<QaRunResult, 'runId' | 'findings'>> {
  return resultSelectionSchema.parse(await readJson<unknown>(filePath)) as unknown as Pick<QaRunResult, 'runId' | 'findings'>;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code === 'EEXIST') throw new Error(`immutable Beta.9 artifact already exists: ${absolute}`);
    throw error;
  }
}

function assertPlan(plan: Beta9Plan): void {
  const validation = validateBeta9Plan(plan);
  if (!validation.valid) throw new Error(`invalid Beta.9 plan: ${validation.errors.join('; ')}`);
}

const program = new Command();
program.name('aiqa-beta9').description('Beta.9 selected-finding planning, post-QA correlation and approval-bound auto-fix workflow');

program.command('select')
  .requiredOption('--result <path>', 'Beta.7 result.json')
  .requiredOption('--fingerprint <ids...>', 'one or more explicitly selected finding fingerprints')
  .option('--project <name>', 'project display name')
  .option('--out <path>', 'Beta.9 plan output path', '.qa-beta9/plan.json')
  .action(async (options: { result: string; fingerprint: string[]; project?: string; out: string }) => {
    const result = await readQaResult(options.result);
    const plan = buildBeta9Plan({ result: result as QaRunResult, selectedFingerprints: options.fingerprint, project: options.project });
    await writeJson(options.out, plan);
    process.stdout.write(`Beta.9 plan created for ${plan.selectedFindings.length} explicitly selected finding(s). All WorkItems remain mutation-blocked.\n`);
  });

program.command('plan-fix')
  .requiredOption('--plan <path>', 'Beta.9 plan JSON')
  .requiredOption('--item <id>', 'selected Beta.9 WorkItem id')
  .requiredOption('--repo <path>', 'local target git checkout for read-only source context')
  .requiredOption('--model-endpoint <url>', 'provider-neutral Beta.9 fix-plan model gateway')
  .option('--out <path>', 'fix plan output path')
  .action(async (options: { plan: string; item: string; repo: string; modelEndpoint: string; out?: string }) => {
    const beta9 = await readJson<Beta9Plan>(options.plan);
    assertPlan(beta9);
    const model = new HttpBeta9FixModel(options.modelEndpoint, process.env.AIQA_BETA9_TOKEN ?? process.env.AIQA_FIX_TOKEN);
    const planner = new Beta9FixPlanner(model, new LocalGitFixWorkspace(options.repo));
    const result = await planner.plan(beta9, options.item);
    if (!result.planned || !result.plan) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    await writeJson(options.plan, beta9);
    const out = options.out ?? `.qa-beta9/fix-plans/${options.item}.json`;
    await writeJson(out, result.plan);
    process.stdout.write(`Beta.9 fix plan written to ${path.resolve(out)}. Review root cause, risk, files, tests and exact plan hash ${result.plan.planHash}; no repository mutation has occurred.\n`);
  });

program.command('approve-fix')
  .requiredOption('--plan <path>', 'Beta.9 plan JSON')
  .requiredOption('--item <id>', 'selected Beta.9 WorkItem id')
  .requiredOption('--fix-plan <path>', 'reviewed Beta.9 fix plan JSON')
  .requiredOption('--confirm-plan-hash <sha256>', 'exact reviewed fix-plan hash')
  .requiredOption('--approved-by <name>', 'human/operator approval identity')
  .requiredOption('--allow <paths...>', 'repository-relative exact paths or directory/** scopes')
  .option('--scope-hash <sha256>', 'optional pre-reviewed WorkItem scope hash; must match exactly')
  .action(async (options: { plan: string; item: string; fixPlan: string; confirmPlanHash: string; approvedBy: string; allow: string[]; scopeHash?: string }) => {
    const beta9 = await readJson<Beta9Plan>(options.plan);
    assertPlan(beta9);
    const fixPlan = await readJson<Beta9FixPlan>(options.fixPlan);
    if (fixPlan.planHash !== options.confirmPlanHash) throw new Error('approve-fix requires confirmation of the exact reviewed fix-plan hash');
    const item = beta9.workPlan.items.find((candidate) => candidate.id === options.item);
    if (!item) throw new Error(`unknown Beta.9 work item: ${options.item}`);
    const finding = selectedFindingForItem(beta9, options.item);
    const errors = validateBeta9FixPlan(fixPlan, item, finding);
    if (errors.length > 0) throw new Error(`Beta.9 fix plan rejected: ${errors.join('; ')}`);
    approveWorkItem(beta9.workPlan, options.item, { approvedBy: options.approvedBy, allowedPaths: options.allow, scopeHash: options.scopeHash });
    const approved = beta9.workPlan.items.find((candidate) => candidate.id === options.item)!;
    const outside = fixPlan.changes.map((change) => change.path).filter((filePath) => !pathAllowedForWorkItem(filePath, approved));
    if (outside.length > 0) throw new Error(`approved path scope does not include all reviewed fix files: ${outside.join(', ')}`);
    await writeJson(options.plan, beta9);
    process.stdout.write(`Approved ${approved.id} for exact reviewed plan ${fixPlan.planHash}; scope hash ${approved.approval.scopeHash}. No source mutation has occurred yet.\n`);
  });

program.command('execute-fix')
  .requiredOption('--plan <path>', 'approved Beta.9 plan JSON')
  .requiredOption('--item <id>', 'approved Beta.9 WorkItem id')
  .requiredOption('--repo <path>', 'local target git checkout')
  .requiredOption('--fix-plan <path>', 'reviewed Beta.9 fix plan JSON')
  .requiredOption('--confirm-plan-hash <sha256>', 'exact reviewed fix-plan hash')
  .option('--attempt <count>', '1-based attempt number', (value) => Number.parseInt(value, 10), 1)
  .option('--retry-authorization-hash <sha256>', 'required exact retry authorization hash for attempts after 1')
  .option('--confirm-write', 'required acknowledgement before repository mutation', false)
  .option('--attempt-record-out <path>', 'immutable attempt record output path')
  .action(async (options: { plan: string; item: string; repo: string; fixPlan: string; confirmPlanHash: string; attempt: number; retryAuthorizationHash?: string; confirmWrite: boolean; attemptRecordOut?: string }) => {
    if (options.confirmWrite !== true) throw new Error('execute-fix requires --confirm-write');
    const beta9 = await readJson<Beta9Plan>(options.plan);
    assertPlan(beta9);
    const fixPlan = await readJson<Beta9FixPlan>(options.fixPlan);
    const executor = new Beta9FixExecutor(new LocalGitBackendWorkspace(options.repo, 'aiqa/fix'));
    const result = await executor.execute(beta9, options.item, fixPlan, {
      confirmPlanHash: options.confirmPlanHash,
      attempt: options.attempt,
      retryAuthorizationHash: options.retryAuthorizationHash,
    });
    await writeJson(options.plan, beta9);
    const defaultAttemptPath = `.qa-beta9/attempts/${options.item}-attempt-${options.attempt}-${fixPlan.planHash.slice(0, 12)}.json`;
    const attemptPath = options.attemptRecordOut ?? defaultAttemptPath;
    await writeImmutableJson(attemptPath, result.attemptRecord);
    process.stdout.write(`${JSON.stringify({ ...result, attemptRecordPath: path.resolve(attemptPath) }, null, 2)}\n`);
    if (!result.verified) process.exitCode = 2;
  });

program.command('correlate')
  .requiredOption('--plan <path>', 'Beta.9 plan JSON')
  .requiredOption('--item <id>', 'Beta.9 WorkItem id')
  .requiredOption('--before-result <path>', 'source Beta.7 result.json used to create the Beta.9 plan')
  .requiredOption('--after-result <path>', 'fresh post-attempt Beta.7 result.json')
  .requiredOption('--attempt-record <path>', 'immutable Beta.9 attempt record JSON')
  .option('--out <path>', 'immutable correlation report output path')
  .action(async (options: { plan: string; item: string; beforeResult: string; afterResult: string; attemptRecord: string; out?: string }) => {
    const beta9 = await readJson<Beta9Plan>(options.plan);
    assertPlan(beta9);
    const before = await readQaResult(options.beforeResult);
    const after = await readQaResult(options.afterResult);
    const attempt = await readJson<Beta9AttemptEvidence>(options.attemptRecord);
    const report = correlateBeta9Attempt({ beta9, itemId: options.item, before, after, attempt });
    applyBeta9Correlation(beta9, report);
    await writeJson(options.plan, beta9);
    const out = options.out ?? `.qa-beta9/correlations/${options.item}-attempt-${report.attempt}-${report.correlationHash.slice(0, 12)}.json`;
    await writeImmutableJson(out, report);
    process.stdout.write(`${JSON.stringify({ ...report, correlationPath: path.resolve(out) }, null, 2)}\n`);
  });

program.command('prepare-retry')
  .requiredOption('--plan <path>', 'Beta.9 plan JSON')
  .requiredOption('--correlation <path>', 'reviewed immutable correlation report JSON')
  .requiredOption('--attempt-record <path>', 'previous immutable attempt record JSON')
  .requiredOption('--repo <path>', 'local target git checkout')
  .option('--out <path>', 'immutable retry authorization output path')
  .action(async (options: { plan: string; correlation: string; attemptRecord: string; repo: string; out?: string }) => {
    const beta9 = await readJson<Beta9Plan>(options.plan);
    assertPlan(beta9);
    const correlation = await readJson<Beta9CorrelationReport>(options.correlation);
    const correlationErrors = validateBeta9CorrelationReport(correlation);
    if (correlationErrors.length > 0) throw new Error(`invalid Beta.9 correlation report: ${correlationErrors.join('; ')}`);
    if (!correlation.retryEligible) throw new Error('correlation report does not permit an automatic retry');
    const attempt = await readJson<Beta9AttemptEvidence>(options.attemptRecord);
    if (attempt.workItemId !== correlation.workItemId || attempt.findingFingerprint !== correlation.findingFingerprint || attempt.attempt !== correlation.attempt || attempt.fixPlanHash !== correlation.fixPlanHash) {
      throw new Error('previous attempt record does not match the correlation report');
    }
    const workspace = new LocalGitBackendWorkspace(options.repo, 'aiqa/fix');
    if (['awaiting-correlation', 'verified'].includes(attempt.outcome)) {
      if (!attempt.originalBranch || !attempt.executionBranch) throw new Error('successful previous attempt is missing branch evidence required for safe retry rollback');
      const currentBranch = await workspace.currentBranch();
      if (currentBranch !== attempt.executionBranch) throw new Error(`safe retry rollback requires current branch ${attempt.executionBranch}; found ${currentBranch}`);
      await workspace.rollback(attempt.originalBranch, attempt.executionBranch);
    }
    const authorization = prepareBeta9Retry(beta9, correlation);
    await writeJson(options.plan, beta9);
    const out = options.out ?? `.qa-beta9/retries/${authorization.workItemId}-attempt-${authorization.nextAttempt}-${authorization.authorizationHash.slice(0, 12)}.json`;
    await writeImmutableJson(out, authorization);
    process.stdout.write(`${JSON.stringify({ ...authorization, authorizationPath: path.resolve(out) }, null, 2)}\n`);
  });

await program.parseAsync(process.argv);
