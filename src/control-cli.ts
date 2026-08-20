#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { ControlPlaneStore } from './control/control-plane.js';
import { isLoopbackHost, startDashboard } from './control/dashboard-server.js';

const program = new Command();
program
  .name('aiqa-dashboard')
  .option('--state <file>', 'control-plane state file', '.qa-control/state.json')
  .option('--beta8-repo <path>', 'optional frontend repository/project root for governed Beta.8 discovery/interview/blueprint/task/mock/final-QA actions')
  .option('--beta8-model-endpoint <url>', 'optional provider-neutral Beta.8 backend implementation model gateway')
  .option('--beta8-mock-model-endpoint <url>', 'optional provider-neutral Beta.8 mock migration model gateway')
  .option('--beta8-beta7-result <file>', 'optional exact Beta.7 result expected from the final Beta.8 QA command; otherwise safe fresh-result discovery is used')
  .option('--beta8-beta7-runs-root <dir>', 'optional Beta.7 run root for final Beta.8 QA discovery; defaults to <beta8-repo>/.qa-runs')
  .option('--beta8-artifacts <dir>', 'Beta.8 dashboard artifact root', '.qa-backend')
  .option('--beta9-plan <file>', 'Beta.9 plan file', '.qa-beta9/plan.json')
  .option('--beta7-result <file>', 'optional source Beta.7 result used directly by Beta.9; if omitted, a completed Beta.8 final-QA handoff can provide it')
  .option('--beta9-repo <path>', 'optional local target git checkout for governed Beta.9 planning/execution; defaults to the Beta.8 repo when omitted by the dashboard server')
  .option('--beta9-model-endpoint <url>', 'optional provider-neutral Beta.9 fix-plan model gateway')
  .option('--beta9-post-result <file>', 'optional exact fresh post-fix Beta.7 result; overrides safe auto-discovery')
  .option('--beta9-post-results-root <dir>', 'optional Beta.7 run root for unambiguous fresh-result auto-discovery; defaults to <beta9-repo>/.qa-runs or <beta8-repo>/.qa-runs')
  .option('--beta9-artifacts <dir>', 'Beta.9 dashboard artifact root', '.qa-beta9')
  .option('--allow-actions', 'allow explicit loopback-only Beta.8/Beta.9 actions; repository mutation remains separately approval-gated', false)
  .option('--host <host>', 'bind host', '127.0.0.1')
  .option('--port <number>', 'bind port', '8787')
  .option('--allow-remote', 'allow non-loopback bind when AIQA_DASHBOARD_TOKEN is also set', false);
program.parse();
const raw = program.opts();
const port = Number(raw.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');
const loopback = isLoopbackHost(raw.host);
if (!loopback && raw.allowRemote !== true) throw new Error('remote dashboard bind requires --allow-remote');
if (!loopback && raw.allowActions === true) throw new Error('--allow-actions is restricted to a loopback dashboard');
const token = loopback ? undefined : process.env.AIQA_DASHBOARD_TOKEN;
if (!loopback && !token) throw new Error('remote dashboard bind requires AIQA_DASHBOARD_TOKEN');
const beta8RunsRoot = raw.beta8Beta7RunsRoot ?? (raw.beta8Repo ? path.join(raw.beta8Repo, '.qa-runs') : undefined);
const beta9Repo = raw.beta9Repo ?? raw.beta8Repo;
const postResultsRoot = raw.beta9PostResultsRoot ?? (beta9Repo ? path.join(beta9Repo, '.qa-runs') : undefined);
const started = await startDashboard(new ControlPlaneStore(raw.state), {
  host: raw.host,
  port,
  token,
  beta8RepoPath: raw.beta8Repo,
  beta8ArtifactRoot: raw.beta8Artifacts,
  beta8ModelEndpoint: raw.beta8ModelEndpoint,
  beta8ModelToken: process.env.AIQA_BACKEND_TOKEN,
  beta8MockModelEndpoint: raw.beta8MockModelEndpoint,
  beta8MockModelToken: process.env.AIQA_BETA8_MOCK_TOKEN ?? process.env.AIQA_BACKEND_TOKEN,
  beta8Beta7ResultPath: raw.beta8Beta7Result,
  beta8Beta7RunsRoot: beta8RunsRoot,
  beta9PlanPath: raw.beta9Plan,
  beta7ResultPath: raw.beta7Result,
  beta9RepoPath: beta9Repo,
  beta9ModelEndpoint: raw.beta9ModelEndpoint,
  beta9PostResultPath: raw.beta9PostResult,
  beta9PostResultsRoot: postResultsRoot,
  beta9ArtifactRoot: raw.beta9Artifacts,
  beta9ModelToken: process.env.AIQA_BETA9_TOKEN ?? process.env.AIQA_FIX_TOKEN,
  allowActions: raw.allowActions === true,
});
console.log(`AI QA dashboard listening on http://${started.host}:${started.port}`);
