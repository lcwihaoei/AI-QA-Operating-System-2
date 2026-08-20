#!/usr/bin/env node
import { Command } from 'commander';
import { FixAgent } from './fix/fix-agent.js';
import { loadFindingInput } from './fix/finding-loader.js';
import { LocalGitFixWorkspace } from './fix/local-git-fix-workspace.js';
import { HttpFixModel } from './providers/http-fix-model.js';

const program = new Command();
program
  .name('aiqa-fix')
  .option('--finding <json>', 'path to one serialized Finding JSON')
  .option('--result <json>', 'QA result.json; use with --fingerprint')
  .option('--fingerprint <id>', 'finding fingerprint to select from --result')
  .requiredOption('--repo <path>', 'local git checkout to inspect/fix')
  .requiredOption('--fix-endpoint <url>', 'provider-neutral fix model gateway')
  .option('--mode <mode>', 'plan or execute', 'plan')
  .option('--confirm-write', 'required for execute mode', false);
program.parse();
const raw = program.opts();
if (!['plan', 'execute'].includes(raw.mode)) throw new Error('--mode must be plan or execute');
if (raw.mode === 'execute' && raw.confirmWrite !== true) throw new Error('--mode execute requires --confirm-write');
const finding = await loadFindingInput({ findingPath: raw.finding, resultPath: raw.result, fingerprint: raw.fingerprint });
const model = new HttpFixModel(raw.fixEndpoint, process.env.AIQA_FIX_TOKEN);
const workspace = new LocalGitFixWorkspace(raw.repo);
const result = await new FixAgent(model, workspace).run({ finding, mode: raw.mode });
console.log(JSON.stringify(result, null, 2));
if (raw.mode === 'execute' && !result.verified) process.exitCode = 2;
