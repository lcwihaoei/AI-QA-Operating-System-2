#!/usr/bin/env node
import { Command } from 'commander';
import { ControlPlaneStore } from './control/control-plane.js';
import { isLoopbackHost, startDashboard } from './control/dashboard-server.js';

const program = new Command();
program
  .name('aiqa-dashboard')
  .option('--state <file>', 'control-plane state file', '.qa-control/state.json')
  .option('--host <host>', 'bind host', '127.0.0.1')
  .option('--port <number>', 'bind port', '8787')
  .option('--allow-remote', 'allow non-loopback bind when AIQA_DASHBOARD_TOKEN is also set', false);
program.parse();
const raw = program.opts();
const port = Number(raw.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');
const loopback = isLoopbackHost(raw.host);
if (!loopback && raw.allowRemote !== true) throw new Error('remote dashboard bind requires --allow-remote');
const token = loopback ? undefined : process.env.AIQA_DASHBOARD_TOKEN;
if (!loopback && !token) throw new Error('remote dashboard bind requires AIQA_DASHBOARD_TOKEN');
const started = await startDashboard(new ControlPlaneStore(raw.state), { host: raw.host, port, token });
console.log(`AI QA dashboard listening on http://${started.host}:${started.port}`);
