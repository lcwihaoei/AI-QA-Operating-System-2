import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlaneStore } from '../src/control/control-plane.js';
import { startDashboard } from '../src/control/dashboard-server.js';

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), 'aiqa-feature-http-'));
  roots.push(value);
  return value;
}

async function request(base: string, method: string, endpoint: string, body?: unknown) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: base,
      'sec-fetch-site': 'same-origin',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() as any };
}

function answer(question: any): string | string[] | boolean {
  if (question.kind === 'boolean') return true;
  if (question.kind === 'multi') return [question.options[0]];
  if (question.kind === 'single') return question.options[0];
  return 'Improve the explicit operator outcome without changing unrelated product behavior.';
}

describe('Product / Feature Planner dashboard HTTP workflow', () => {
  it('drives explicit opportunity → decision interview → immutable blueprint through loopback actions', async () => {
    const dir = await root();
    const started = await startDashboard(new ControlPlaneStore(path.join(dir, '.qa-control', 'state.json')), {
      host: '127.0.0.1',
      port: 0,
      allowActions: true,
      featureArtifactRoot: path.join(dir, '.qa-features'),
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;

    const empty = await request(base, 'GET', '/api/features');
    expect(empty).toMatchObject({ status: 200, json: { available: false, phase: 'empty', actionsAllowed: true } });

    const created = await request(base, 'POST', '/api/features/create', {
      project: 'demo',
      title: 'Guided approval review',
      observation: 'Operators cannot easily verify product scope before implementation.',
      userValue: 'Make the requested outcome, affected areas and risk visible before source changes.',
      expectedImpact: 'high',
      estimatedEffort: 'medium',
      affectedAreas: ['dashboard', 'planning'],
      designSystemConstraints: ['Reuse the existing dashboard visual language.', 'Support 繁體 | English.'],
      currentProductUnderstanding: ['Beta.7 evidence gate exists.', 'Source mutation is independently approval-gated.'],
    });
    expect(created.status).toBe(201);
    expect(created.json.phase).toBe('interview');

    for (const question of created.json.session.questions) {
      const saved = await request(base, 'POST', '/api/features/answer', {
        questionId: question.id,
        value: answer(question),
        confirmed: true,
      });
      expect(saved.status).toBe(200);
    }
    const ready = await request(base, 'GET', '/api/features');
    expect(ready.json).toMatchObject({ phase: 'ready-for-blueprint', validation: { ready: true } });

    const frozen = await request(base, 'POST', '/api/features/blueprint', {
      selectedAlternativeId: 'balanced',
      userFlow: ['Open feature planner', 'Review and confirm product decisions', 'Freeze the product contract'],
      informationArchitecture: ['Features navigation entry', 'Decision interview', 'Blueprint summary'],
      frontendRequirements: ['Reuse the current management dashboard components', 'Support Traditional Chinese and English', 'Support responsive states'],
      backendRequirements: ['Persist bounded planning artifacts only'],
      dataRequirements: ['Do not persist credentials or secrets'],
      securityRequirements: ['Require explicit approval before future source mutation', 'Keep default-deny execution boundaries'],
    });
    expect(frozen.status).toBe(201);
    expect(frozen.json).toMatchObject({ phase: 'blueprint-ready', workPlanValid: true });
    expect(frozen.json.blueprint.workPlan.items.every((item: any) => item.execution.mutationAllowed === false)).toBe(true);

    const overwrite = await request(base, 'POST', '/api/features/blueprint', {
      selectedAlternativeId: 'minimal', userFlow: ['x'], informationArchitecture: [], frontendRequirements: ['x'], backendRequirements: [], dataRequirements: [], securityRequirements: ['x'],
    });
    expect(overwrite.status).toBe(409);

    const html = await fetch(`${base}/`).then((response) => response.text());
    expect(html).toContain('/feature-planner-dashboard.css');
    expect(html).toContain('/feature-planner-dashboard.js');
    expect(html).toContain('繁體');
    const js = await fetch(`${base}/feature-planner-dashboard.js`);
    expect(js.status).toBe(200);
    const jsText = await js.text();
    expect(jsText).toContain('Product / Feature Planner');
    expect(jsText).toContain('產品／功能規劃器');
    expect(jsText).toContain('/api/features/blueprint');
    const css = await fetch(`${base}/feature-planner-dashboard.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('#featurePlannerPage');
  });

  it('keeps planning mutations disabled when dashboard action mode is not enabled', async () => {
    const dir = await root();
    const started = await startDashboard(new ControlPlaneStore(path.join(dir, '.qa-control', 'state.json')), {
      host: '127.0.0.1', port: 0, featureArtifactRoot: path.join(dir, '.qa-features'),
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;
    const summary = await request(base, 'GET', '/api/features');
    expect(summary.json.actionsAllowed).toBe(false);
    const blocked = await request(base, 'POST', '/api/features/create', {
      project: 'demo', title: 'Blocked', observation: 'x', userValue: 'x', expectedImpact: 'low', estimatedEffort: 'low', affectedAreas: [], designSystemConstraints: [], currentProductUnderstanding: [],
    });
    expect(blocked.status).toBe(403);
  });
});
