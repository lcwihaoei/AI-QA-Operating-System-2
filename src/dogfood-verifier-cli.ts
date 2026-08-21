#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import type { QaRunResult } from './core/types.js';
import { verifyBeta10Dogfood, type DogfoodReportDataLike } from './verification/beta10-dogfood-verifier.js';

const program = new Command();
program
  .name('aiqa-dogfood-verify')
  .description('Verify a locally produced Beta.10 real-project QA result without copying private project source into AI-QA')
  .requiredOption('--result <path>', 'path to Beta.10 result.json')
  .option('--report-data <path>', 'path to report/report-data.json')
  .option('--required-route <path...>', 'required application route paths')
  .option('--min-eligible-coverage <number>', 'minimum eligible interaction coverage percentage points', '80')
  .option('--min-videos <number>', 'minimum evidence video count', '3')
  .option('--require-model', 'require planner model participation')
  .option('--require-ux-reasoner', 'require explicit configured UX reasoner state')
  .option('--candidate-sha <sha>', 'actual candidate commit SHA recorded by the authorized runner')
  .option('--expected-candidate-sha <sha>', 'expected candidate commit SHA')
  .option('--candidate-version <version>', 'actual candidate package/release version')
  .option('--expected-version <version>', 'expected candidate package/release version')
  .parse(process.argv);

const options = program.opts<{
  result: string;
  reportData?: string;
  requiredRoute?: string[];
  minEligibleCoverage: string;
  minVideos: string;
  requireModel?: boolean;
  requireUxReasoner?: boolean;
  candidateSha?: string;
  expectedCandidateSha?: string;
  candidateVersion?: string;
  expectedVersion?: string;
}>();

const result = JSON.parse(await readFile(options.result, 'utf8')) as QaRunResult;
let reportData: DogfoodReportDataLike | undefined;
if (options.reportData) reportData = JSON.parse(await readFile(options.reportData, 'utf8')) as DogfoodReportDataLike;

const verification = verifyBeta10Dogfood(result, {
  requiredPaths: options.requiredRoute,
  minEligibleCoverage: Number(options.minEligibleCoverage),
  minVideos: Number(options.minVideos),
  requireModel: options.requireModel === true,
  requireUxReasoner: options.requireUxReasoner === true,
  reportData,
  candidateSha: options.candidateSha,
  expectedCandidateSha: options.expectedCandidateSha,
  candidateVersion: options.candidateVersion,
  expectedVersion: options.expectedVersion,
});

process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
process.exitCode = verification.status === 'PASS' ? 0 : verification.status === 'BLOCKED' ? 2 : 1;
