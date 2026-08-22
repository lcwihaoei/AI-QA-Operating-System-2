import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { DomGeometryAnalyzer } from '../src/visual/dom-geometry-analyzer.js';

const enabled = process.env.AIQA_BROWSER_E2E === '1';

describe.skipIf(!enabled)('DOM geometry real-browser false-positive regressions', () => {
  it('suppresses intentional inactive/truncated/scrollable states while preserving real viewport defects', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(`<!doctype html><html><head><style>
        body { margin: 0; min-height: 2200px; }
        .visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
        .offcanvas { position: fixed; left: -320px; top: 0; width: 300px; height: 600px; }
        .mobile-menu { position: fixed; left: 0; top: 0; width: 280px; height: 600px; transform: translateX(-100%); }
        .drawer-right { position: fixed; right: -300px; top: 0; width: 280px; height: 600px; }
        .sidebar.show { position: fixed; top:360px; left:0; width:200px; height:120px; }
        #below { position:absolute; top:1800px; left:40px; width:160px; height:40px; }
        #real-horizontal { position:fixed; top:100px; left:850px; width:120px; height:40px; }
        #transparent-shell { opacity: 0; }
        #transparent-hidden { position:fixed; top:150px; left:880px; width:120px; height:40px; }
        #scrollbox { position:fixed; top:220px; left:20px; width:240px; overflow-x:auto; }
        #scrollcontent { width:1200px; height:60px; position:relative; }
        #scroll-reachable { position:absolute; left:900px; top:10px; width:140px; height:40px; }
        #ellipsis { position:fixed; top:300px; left:20px; width:90px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
        #sidebar-broken { position:absolute; left:860px; top:10px; width:150px; height:40px; }
        #disabled-offscreen { position:fixed; top:500px; left:900px; width:140px; height:40px; }
      </style></head><body>
        <span class="visually-hidden">Screen reader label that is intentionally clipped</span>
        <nav class="offcanvas"><a href="/hidden">Hidden drawer link</a></nav>
        <nav class="mobile-menu"><button>Translated closed mobile menu</button></nav>
        <aside class="drawer-right"><button>Negative inset closed drawer</button></aside>
        <button id="below">Normal below fold</button>
        <button id="real-horizontal">Actually unreachable</button>
        <div id="transparent-shell"><button id="transparent-hidden">Transparent hidden control</button></div>
        <div id="scrollbox"><div id="scrollcontent"><button id="scroll-reachable">Scrollable reachable control</button></div></div>
        <p id="ellipsis">Intentional ellipsis text that is expected to truncate visually</p>
        <aside class="sidebar show" aria-hidden="false"><button id="sidebar-broken">Visible sidebar broken action</button></aside>
        <button id="disabled-offscreen" disabled>Disabled unreachable control</button>
      </body></html>`);

      const signals = await new DomGeometryAnalyzer().analyze(page);
      const messages = signals.map((signal) => signal.message).join('\n');
      expect(messages).not.toContain('Screen reader label');
      expect(messages).not.toContain('Hidden drawer link');
      expect(messages).not.toContain('Translated closed mobile menu');
      expect(messages).not.toContain('Negative inset closed drawer');
      expect(messages).not.toContain('Normal below fold');
      expect(messages).not.toContain('Transparent hidden control');
      expect(messages).not.toContain('Scrollable reachable control');
      expect(messages).not.toContain('Intentional ellipsis text');
      expect(messages).not.toContain('Disabled unreachable control');
      expect(messages).toContain('Actually unreachable');
      expect(messages).toContain('Visible sidebar broken action');
    } finally {
      await browser.close();
    }
  });
});
