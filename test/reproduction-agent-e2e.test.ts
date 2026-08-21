import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { QaEvent } from '../src/core/types.js';
import { ReproductionAgent } from '../src/reproduction/reproduction-agent.js';

const enabled = process.env.AIQA_BROWSER_E2E === '1';
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixtureUrl(): Promise<string> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><style>
      body { margin:0; }
      #bad { position:fixed; left:850px; top:120px; width:120px; height:40px; }
    </style></head><body><button id="bad">Bad</button></body></html>`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server address unavailable');
  return `http://127.0.0.1:${address.port}/`;
}

function signal(url: string, element = 'button#bad "Bad"'): QaEvent {
  return {
    timestamp: '2026-08-21T00:00:00.000Z',
    kind: 'ui',
    url,
    message: `Interactive element is unreachable or clipped by the viewport: ${element} [viewport=tablet 800x600]`,
    details: {
      visual: true,
      visualKind: 'interactive-offscreen',
      viewport: 'tablet',
      viewportWidth: 800,
      viewportHeight: 600,
      element,
      rect: { x: 850, y: 120, width: 120, height: 40 },
      screenshot: '/tmp/run/finding.png',
    },
  };
}

describe.skipIf(!enabled)('Beta.10 ReproductionAgent real-browser contract', () => {
  it('confirms the same detector signal only when a fresh Chromium context emits it independently', async () => {
    const url = await fixtureUrl();
    const result = await new ReproductionAgent(undefined, undefined, 4).run([signal(url)]);
    expect(result.summary).toMatchObject({ eligible: 1, attempted: 1, confirmed: 1, notReproduced: 0 });
    expect(result.events[0]?.details?.reproductionStatus).toBe('confirmed');
    expect(result.events[0]?.details?.reproductionReason).toMatch(/fresh browser context/i);
  });

  it('marks a detector identity that does not recur in the fresh context as not reproduced', async () => {
    const url = await fixtureUrl();
    const result = await new ReproductionAgent(undefined, undefined, 4).run([signal(url, 'button#missing "Missing"')]);
    expect(result.summary).toMatchObject({ eligible: 1, attempted: 1, confirmed: 0, notReproduced: 1 });
    expect(result.events[0]?.details?.reproductionStatus).toBe('not-reproduced');
  });
});
