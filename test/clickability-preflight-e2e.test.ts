import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { clickabilityPreflight } from '../src/planning/clickability-preflight.js';

const enabled = process.env.AIQA_BROWSER_E2E === '1';

describe.skipIf(!enabled)('clickability preflight real Chromium regression', () => {
  it('accepts reachable controls and rejects intercepted or persistently offscreen targets without clicking', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(`<!doctype html><html><head><style>
        body { margin: 0; min-height: 2400px; }
        button { width: 180px; height: 44px; }
        #visible { position: absolute; left: 40px; top: 40px; }
        #below { position: absolute; left: 40px; top: 1500px; }
        #covered { position: fixed; left: 300px; top: 100px; }
        #overlay { position: fixed; left: 280px; top: 80px; width: 240px; height: 100px; z-index: 10; background: rgba(0,0,0,.2); }
        #fixed-offscreen { position: fixed; left: 980px; top: 240px; }
      </style></head><body>
        <button id="visible">Visible action</button>
        <button id="below">Below fold action</button>
        <button id="covered">Covered action</button>
        <div id="overlay">Overlay</div>
        <button id="fixed-offscreen">Fixed offscreen action</button>
      </body></html>`);

      await expect(clickabilityPreflight(page.locator('#visible'))).resolves.toMatchObject({
        clickable: true,
        reason: 'clickable',
      });
      await expect(clickabilityPreflight(page.locator('#below'))).resolves.toMatchObject({
        clickable: true,
        reason: 'clickable',
      });

      const covered = await clickabilityPreflight(page.locator('#covered'));
      expect(covered).toMatchObject({ clickable: false, reason: 'pointer-intercepted' });
      expect(covered.detail).toContain('#overlay');

      await expect(clickabilityPreflight(page.locator('#fixed-offscreen'))).resolves.toMatchObject({
        clickable: false,
        reason: 'outside-viewport',
      });
    } finally {
      await browser.close();
    }
  }, 15_000);
});
