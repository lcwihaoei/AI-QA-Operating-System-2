import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpAppiumDeviceProvider } from '../src/providers/http-appium-device-provider.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('HttpAppiumDeviceProvider', () => {
  it('rejects insecure non-loopback HTTP Appium endpoints', () => {
    expect(() => new HttpAppiumDeviceProvider('http://appium.example.test:4723')).toThrow(/HTTPS/);
    expect(() => new HttpAppiumDeviceProvider('http://127.0.0.1:4723')).not.toThrow();
  });

  it('creates a W3C Android session, reads evidence and always uses no redirects', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: { sessionId: 'session-1', capabilities: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: '<hierarchy><node/></hierarchy>' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: png }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: null }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new HttpAppiumDeviceProvider('http://127.0.0.1:4723/wd/hub/', 'secret-token');
    const session = await provider.startSession({
      platform: 'android',
      capabilities: {
        platformName: 'iOS',
        'appium:deviceName': 'QA Pixel',
      },
    });
    expect(session).toEqual({ id: 'session-1', platform: 'android' });
    expect(await provider.getPageSource(session)).toContain('<node/>');
    expect(await provider.getScreenshotBase64(session)).toBe(png);
    await provider.stopSession(session);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [sessionUrl, sessionInit] = fetchMock.mock.calls[0]!;
    expect(sessionUrl).toBe('http://127.0.0.1:4723/wd/hub/session');
    expect(sessionInit.redirect).toBe('error');
    expect(sessionInit.headers.authorization).toBe('Bearer secret-token');
    const body = JSON.parse(String(sessionInit.body));
    expect(body.capabilities.alwaysMatch.platformName).toBe('Android');
    expect(body.capabilities.alwaysMatch['appium:automationName']).toBe('UiAutomator2');
    expect(body.capabilities.alwaysMatch['appium:deviceName']).toBe('QA Pixel');
  });

  it('queries Android and iOS app state using platform-correct execute arguments', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: 4 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: 3 }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = new HttpAppiumDeviceProvider('http://127.0.0.1:4723');

    expect(await provider.queryApplicationState({ id: 'android-1', platform: 'android' }, 'com.example.app')).toBe(4);
    expect(await provider.queryApplicationState({ id: 'ios-1', platform: 'ios' }, 'com.example.ios')).toBe(3);

    const [androidUrl, androidInit] = fetchMock.mock.calls[0]!;
    expect(androidUrl).toBe('http://127.0.0.1:4723/session/android-1/execute/sync');
    expect(androidInit.redirect).toBe('error');
    expect(JSON.parse(String(androidInit.body))).toEqual({ script: 'mobile: queryAppState', args: [{ appId: 'com.example.app' }] });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ script: 'mobile: queryAppState', args: [{ bundleId: 'com.example.ios' }] });
  });

  it('queries active iOS bundle identity without exposing it through another transport path', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      value: { bundleId: 'com.example.ios', pid: 123, name: 'Example' },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = new HttpAppiumDeviceProvider('http://127.0.0.1:4723');

    await expect(provider.getActiveApplicationId({ id: 'ios-1', platform: 'ios' })).resolves.toBe('com.example.ios');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4723/session/ios-1/execute/sync');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({ script: 'mobile: activeAppInfo', args: [] });
    await expect(provider.getActiveApplicationId({ id: 'android-1', platform: 'android' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when optional app identity/state extensions are unsupported', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: { error: 'unknown command', message: 'unsupported' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: { error: 'unknown command', message: 'unsupported' } }), { status: 404 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = new HttpAppiumDeviceProvider('http://127.0.0.1:4723');
    await expect(provider.queryApplicationState({ id: 'session-1', platform: 'android' }, 'com.example.app')).resolves.toBeUndefined();
    await expect(provider.getActiveApplicationId({ id: 'session-2', platform: 'ios' })).resolves.toBeUndefined();
  });

  it('sends a bounded W3C touch action and releases actions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: null }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const provider = new HttpAppiumDeviceProvider('http://127.0.0.1:4723');
    const session = { id: 'session-1', platform: 'ios' as const };

    await provider.tap(session, 123, 456);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4723/session/session-1/actions');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    const body = JSON.parse(String(init.body));
    expect(body.actions[0].parameters.pointerType).toBe('touch');
    expect(body.actions[0].actions[0]).toMatchObject({ type: 'pointerMove', x: 123, y: 456, origin: 'viewport' });
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');

    await expect(provider.tap(session, -1, 2)).rejects.toThrow(/coordinates/);
    await expect(provider.tap(session, 30_000, 2)).rejects.toThrow(/coordinates/);
  });
});
