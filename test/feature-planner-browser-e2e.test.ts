import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlPlaneStore } from '../src/control/control-plane.js';
import { startDashboard } from '../src/control/dashboard-server.js';

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

const browserEnabled = process.env.AIQA_BROWSER_E2E === '1';

describe('Product / Feature Planner real-browser dashboard regression', () => {
  it.runIf(browserEnabled)('renders the bilingual planner on desktop and keeps it reachable in mobile RWD navigation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-feature-browser-'));
    roots.push(root);
    const started = await startDashboard(new ControlPlaneStore(path.join(root, '.qa-control', 'state.json')), {
      host: '127.0.0.1', port: 0, featureArtifactRoot: path.join(root, '.qa-features'),
    });
    servers.push(started.server);
    const base = `http://127.0.0.1:${started.port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(base, { waitUntil: 'networkidle' });
      const sideFeature = page.locator('.sidebar [data-route="features"]');
      expect(await sideFeature.count()).toBe(1);
      await sideFeature.click();
      expect(await page.locator('#featurePlannerPage').getAttribute('class')).toContain('is-active');
      expect(await page.locator('#featurePlannerPage h1').textContent()).toContain('Product / Feature Planner');
      expect(await page.locator('#fpStart').isDisabled()).toBe(true);

      await page.locator('.topbar [data-locale="zh-TW"]').click();
      await page.waitForFunction(() => document.documentElement.lang === 'zh-TW');
      await page.waitForFunction(() => document.querySelector('#featurePlannerPage h1')?.textContent?.includes('產品／功能規劃器'));
      await page.waitForFunction(() => document.querySelector('.sidebar [data-route="features"] b')?.textContent?.includes('功能規劃'));
      expect(await page.locator('#featurePlannerPage h1').textContent()).toContain('產品／功能規劃器');
      expect(await sideFeature.locator('b').textContent()).toContain('功能規劃');

      await page.setViewportSize({ width: 390, height: 844 });
      const mobileFeature = page.locator('.mobile-nav [data-route="features"]');
      expect(await mobileFeature.isVisible()).toBe(true);
      await mobileFeature.click();
      expect(await page.locator('#featurePlannerPage').getAttribute('class')).toContain('is-active');
      const columns = await page.locator('#featurePlannerPage .fp-grid').first().evaluate((element) => getComputedStyle(element).gridTemplateColumns);
      expect(columns.trim().split(/\s+/)).toHaveLength(1);
    } finally {
      await browser.close();
    }
  }, 35_000);
});
