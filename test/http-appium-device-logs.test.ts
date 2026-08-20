import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpAppiumDeviceProvider } from '../src/providers/http-appium-device-provider.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('HttpAppiumDeviceProvider log transport', () => {
  it('lists log types and fetches bounded W3C/Appium log entries without redirects', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: ['logcat', 'server', 'logcat'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [
          { level: 'SEVERE', message: 'E/AndroidRuntime: fatal sample', timestamp: 123 },
          { level: 'INFO', message: 'ordinary sample', timestamp: 124 },
        ],
      }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new HttpAppiumDeviceProvider('http://127.0.0.1:4723');
    const session = { id: 'session-1', platform: 'android' as const };

    await expect(provider.getAvailableLogTypes(session)).resolves.toEqual(['logcat', 'server']);
    await expect(provider.getLogEntries(session, 'logcat')).resolves.toEqual([
      { level: 'SEVERE', message: 'E/AndroidRuntime: fatal sample', timestamp: 123 },
      { level: 'INFO', message: 'ordinary sample', timestamp: 124 },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4723/session/session-1/se/log/types');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:4723/session/session-1/se/log');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe('error');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ type: 'logcat' });
  });

  it('fails closed to an empty optional log signal when the provider does not support logs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: { error: 'unknown command', message: 'unsupported' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: { error: 'unknown command', message: 'unsupported' } }), { status: 404 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new HttpAppiumDeviceProvider('http://127.0.0.1:4723');
    const session = { id: 'session-1', platform: 'ios' as const };
    await expect(provider.getAvailableLogTypes(session)).resolves.toEqual([]);
    await expect(provider.getLogEntries(session, 'crashlog')).resolves.toEqual([]);
  });
});
