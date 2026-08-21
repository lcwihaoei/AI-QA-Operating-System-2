import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { captureInteractionStateFingerprint } from '../src/planning/interaction-state-fingerprint.js';

const enabled = process.env.AIQA_BROWSER_E2E === '1';

describe.skipIf(!enabled)('interaction-state fingerprint real Chromium regression', () => {
  it('changes for material UI structure/state but ignores field values and unrelated text churn', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(`<!doctype html><html><body>
        <p id="clock">12:00</p>
        <button id="toggle" type="button" aria-controls="panel" aria-expanded="false">Toggle</button>
        <input id="search" name="search" value="">
        <section id="panel" hidden><button id="panel-action" type="button">Panel action</button></section>
      </body></html>`);

      const initial = await captureInteractionStateFingerprint(page);

      await page.locator('#search').fill('private user-entered value');
      await page.locator('#clock').evaluate((node) => { node.textContent = '12:01 random text'; });
      const contentOnly = await captureInteractionStateFingerprint(page);
      expect(contentOnly).toBe(initial);

      await page.locator('#toggle').evaluate((node) => node.setAttribute('aria-expanded', 'true'));
      await page.locator('#panel').evaluate((node) => node.removeAttribute('hidden'));
      const opened = await captureInteractionStateFingerprint(page);
      expect(opened).not.toBe(initial);

      await page.locator('#toggle').evaluate((node) => node.setAttribute('aria-expanded', 'false'));
      await page.locator('#panel').evaluate((node) => node.setAttribute('hidden', ''));
      const closedAgain = await captureInteractionStateFingerprint(page);
      expect(closedAgain).toBe(initial);
    } finally {
      await browser.close();
    }
  }, 15_000);
});
