#!/usr/bin/env node
import { Command } from 'commander';
import { ControlPlaneStore } from './control/control-plane.js';
import { isLoopbackHost, startDashboard } from './control/dashboard-server.js';

const program = new Command();
program
  .name('aiqa-dashboard')
  .option('--state <file>', 'control-plane state file', '.qa-control/state.json')
  .option('--beta9-plan <file>', 'read-only Beta.9 plan file', '.qa-beta9/plan.json')
  .option('--beta7-result <file>', 'optional Beta.7 result file used to display/select findings')
  .option('--allow-actions', 'allow loopback-only Beta.9 finding selection plan creation; never enables source-code mutation', false)
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
const started = await startDashboard(new ControlPlaneStore(raw.state), {
  host: raw.host,
  port,
  token,
  beta9PlanPath: raw.beta9Plan,
  beta7ResultPath: raw.beta7Result,
  allowActions: raw.allowActions === true,
});
console.log(`AI QA dashboard listening on http://${started.host}:${started.port}`);
