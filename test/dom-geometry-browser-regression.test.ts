import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { DomGeometryAnalyzer } from '../src/visual/dom-geometry-analyzer.js';

const enabled = process.env.AIQA_BROWSER_E2E === '1';

describe.skipIf(!enabled)('DOM geometry real-browser false-positive regressions', () => {
  it('ignores visually-hidden, closed off-canvas and normal below-fold controls', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(`<!doctype html><html><head><style>
        body { margin: 0; min-height: 2200px; }
        .visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
        .offcanvas { position: fixed; left: -320px; top: 0; width: 300px; height: 600px; }
        #below { position:absolute; top:1800px; left:40px; width:160px; height:40px; }
        #real-horizontal { position:fixed; top:100px; left:850px; width:120px; height:40px; }
      </style></head><body>
        <span class="visually-hidden">Screen reader label that is intentionally clipped</span>
        <nav class="offcanvas" aria-hidden="true"><a href="/hidden">Hidden drawer link</a></nav>
        <button id="below">Normal below fold</button>
        <button id="real-horizontal">Actually unreachable</button>
      </body></html>`);

      const signals = await new DomGeometryAnalyzer().analyze(page);
      const messages = signals.map((signal) => signal.message).join('\n');
      expect(messages).not.toContain('Screen reader label');
      expect(messages).not.toContain('Hidden drawer link');
      expect(messages).not.toContain('Normal below fold');
      expect(messages).toContain('Actually unreachable');
    } finally {
      await browser.close();
    }
  });
});
