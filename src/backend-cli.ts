import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { buildArchitectureInterview, validateArchitectureAnswers, type ArchitectureAnswer, type ArchitectureInterview } from './backend/architecture-interview.js';
import { BackendTaskExecutor } from './backend/backend-executor.js';
import { discoverFrontend, type FrontendDiscoveryResult } from './backend/frontend-discovery.js';
import { LocalGitBackendWorkspace } from './backend/local-git-backend-workspace.js';
import { buildBackendBlueprint, type BackendBlueprint } from './backend/security-blueprint.js';
import type { BackendImplementationModel, BackendTaskProposal, BackendVerificationCommand } from './backend/executor-types.js';
import { approveWorkItem, computeWorkItemScopeHash, workPlanFromBackendBlueprint, type WorkPlan } from './planning/work-item.js';
import { HttpBackendImplementationModel } from './providers/http-backend-model.js';

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code === 'EEXIST') throw new Error(`immutable execution record already exists: ${absolute}`);
    throw error;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8')) as T;
}

const unusedModel: BackendImplementationModel = {
  async propose() { throw new Error('model is not used during execution of an already-generated proposal'); },
};

const program = new Command();
program.name('aiqa-backend').description('Beta.8 frontend discovery, architecture planning and approval-bound backend execution');

program.command('discover')
  .requiredOption('--repo <path>', 'frontend repository/project root')
  .option('--out <path>', 'output directory', '.qa-backend')
  .option('--max-files <count>', 'maximum files to scan', (value) => Number.parseInt(value, 10), 8000)
  .option('--max-file-bytes <count>', 'maximum bytes per source file', (value) => Number.parseInt(value, 10), 1500000)
  .action(async (options: { repo: string; out: string; maxFiles: number; maxFileBytes: number }) => {
    const discovery = await discoverFrontend(options.repo, { maxFiles: options.maxFiles, maxFileBytes: options.maxFileBytes });
    const interview = buildArchitectureInterview(discovery);
    const outDir = path.resolve(options.out);
    await writeJson(path.join(outDir, 'frontend-discovery.json'), discovery);
    await writeJson(path.join(outDir, 'architecture-interview.json'), interview);
    process.stdout.write(`Frontend discovery complete: ${discovery.filesScanned} file(s), ${discovery.routes.length} route(s), ${discovery.mockSources.length} mock source(s).\n`);
    process.stdout.write(`Review ${path.join(outDir, 'frontend-discovery.json')} and ${path.join(outDir, 'architecture-interview.json')} before any backend generation.\n`);
  });

program.command('validate-interview')
  .requiredOption('--interview <path>', 'architecture-interview.json path')
  .requiredOption('--answers <path>', 'JSON array of architecture answers')
  .action(async (options: { interview: string; answers: string }) => {
    const interview = await readJson<ArchitectureInterview>(options.interview);
    const answers = await readJson<ArchitectureAnswer[]>(options.answers);
    if (!Array.isArray(answers)) throw new Error('answers file must contain a JSON array');
    const validation = validateArchitectureAnswers(interview, answers);
    process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
    if (!validation.readyForBlueprint) process.exitCode = 2;
  });

program.command('blueprint')
  .requiredOption('--discovery <path>', 'frontend-discovery.json path')
  .requiredOption('--interview <path>', 'architecture-interview.json path')
  .requiredOption('--answers <path>', 'confirmed architecture answers JSON array')
  .option('--out <path>', 'blueprint output path', '.qa-backend/backend-blueprint.json')
  .action(async (options: { discovery: string; interview: string; answers: string; out: string }) => {
    const discovery = await readJson<FrontendDiscoveryResult>(options.discovery);
    const interview = await readJson<ArchitectureInterview>(options.interview);
    const answers = await readJson<ArchitectureAnswer[]>(options.answers);
    if (!Array.isArray(answers)) throw new Error('answers file must contain a JSON array');
    const blueprint = buildBackendBlueprint({ discovery, interview, answers });
    await writeJson(path.resolve(options.out), blueprint);
    process.stdout.write(`Security-first backend blueprint written to ${path.resolve(options.out)}. Execution remains approval-blocked.\n`);
  });

program.command('work-plan')
  .requiredOption('--blueprint <path>', 'confirmed backend-blueprint.json path')
  .option('--out <path>', 'work-plan output path', '.qa-backend/work-plan.json')
  .action(async (options: { blueprint: string; out: string }) => {
    const blueprint = await readJson<BackendBlueprint>(options.blueprint);
    const plan = workPlanFromBackendBlueprint(blueprint);
    await writeJson(path.resolve(options.out), plan);
    process.stdout.write(`Approval-blocked work plan written to ${path.resolve(options.out)}.\n`);
  });

program.command('scope-hash')
  .requiredOption('--plan <path>', 'work-plan.json path')
  .requiredOption('--item <id>', 'work item id')
  .requiredOption('--allow <paths...>', 'repository-relative exact paths or directory/** scopes')
  .action(async (options: { plan: string; item: string; allow: string[] }) => {
    const plan = await readJson<WorkPlan>(options.plan);
    const item = plan.items.find((candidate) => candidate.id === options.item);
    if (!item) throw new Error(`unknown work item: ${options.item}`);
    process.stdout.write(`${computeWorkItemScopeHash(item, options.allow)}\n`);
  });

program.command('approve-task')
  .requiredOption('--plan <path>', 'work-plan.json path')
  .requiredOption('--item <id>', 'work item id')
  .requiredOption('--approved-by <name>', 'human/operator approval identity')
  .requiredOption('--allow <paths...>', 'repository-relative exact paths or directory/** scopes')
  .option('--scope-hash <sha256>', 'optional pre-reviewed scope hash; must match exactly')
  .action(async (options: { plan: string; item: string; approvedBy: string; allow: string[]; scopeHash?: string }) => {
    const plan = await readJson<WorkPlan>(options.plan);
    approveWorkItem(plan, options.item, { approvedBy: options.approvedBy, allowedPaths: options.allow, scopeHash: options.scopeHash });
    await writeJson(path.resolve(options.plan), plan);
    const approved = plan.items.find((candidate) => candidate.id === options.item)!;
    process.stdout.write(`Approved ${approved.id} with scope hash ${approved.approval.scopeHash}. No repository mutation has occurred.\n`);
  });

program.command('propose-task')
  .requiredOption('--plan <path>', 'approved work-plan.json path')
  .requiredOption('--item <id>', 'approved work item id')
  .requiredOption('--repo <path>', 'local target git checkout')
  .requiredOption('--model-endpoint <url>', 'provider-neutral backend implementation model gateway')
  .option('--out <path>', 'proposal output path')
  .action(async (options: { plan: string; item: string; repo: string; modelEndpoint: string; out?: string }) => {
    const plan = await readJson<WorkPlan>(options.plan);
    const model = new HttpBackendImplementationModel(options.modelEndpoint, process.env.AIQA_BACKEND_TOKEN);
    const executor = new BackendTaskExecutor(model, new LocalGitBackendWorkspace(options.repo));
    const result = await executor.propose(plan, options.item);
    if (!result.planned || !result.proposal) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    const out = path.resolve(options.out ?? `.qa-backend/proposals/${options.item}.json`);
    await writeJson(out, result.proposal);
    process.stdout.write(`Proposal written to ${out}. Review it, then confirm exact proposal hash ${result.proposal.proposalHash} before execution.\n`);
  });

program.command('execute-task')
  .requiredOption('--plan <path>', 'approved work-plan.json path')
  .requiredOption('--item <id>', 'approved work item id')
  .requiredOption('--repo <path>', 'local target git checkout')
  .requiredOption('--proposal <path>', 'reviewed proposal JSON path')
  .requiredOption('--confirm-proposal-hash <sha256>', 'exact reviewed proposal hash')
  .option('--beta7-command <path>', 'operator-reviewed JSON command for the Beta.7 QA gate')
  .option('--attempt <count>', '1-based attempt number', (value) => Number.parseInt(value, 10), 1)
  .option('--confirm-write', 'required acknowledgement before target repository mutation', false)
  .option('--attempt-record-out <path>', 'immutable attempt record path')
  .action(async (options: { plan: string; item: string; repo: string; proposal: string; confirmProposalHash: string; beta7Command?: string; attempt: number; confirmWrite: boolean; attemptRecordOut?: string }) => {
    if (options.confirmWrite !== true) throw new Error('execute-task requires --confirm-write');
    const plan = await readJson<WorkPlan>(options.plan);
    const proposal = await readJson<BackendTaskProposal>(options.proposal);
    const beta7Qa = options.beta7Command ? await readJson<BackendVerificationCommand>(options.beta7Command) : undefined;
    const executor = new BackendTaskExecutor(unusedModel, new LocalGitBackendWorkspace(options.repo));
    const result = await executor.execute(plan, options.item, proposal, { confirmProposalHash: options.confirmProposalHash, attempt: options.attempt, beta7Qa });
    await writeJson(path.resolve(options.plan), plan);
    const defaultAttemptPath = `.qa-backend/attempts/${options.item}-attempt-${options.attempt}-${proposal.proposalHash.slice(0, 12)}.json`;
    const attemptPath = path.resolve(options.attemptRecordOut ?? defaultAttemptPath);
    await writeImmutableJson(attemptPath, result.attemptRecord);
    process.stdout.write(`${JSON.stringify({ ...result, attemptRecordPath: attemptPath }, null, 2)}\n`);
    if (!result.verified) process.exitCode = 2;
  });

await program.parseAsync(process.argv);
