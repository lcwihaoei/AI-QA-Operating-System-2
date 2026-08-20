import { isSecureServiceEndpoint } from '../security/url-policy.js';
import type {
  DeviceLogEntry,
  DevicePlatform,
  DeviceProvider,
  DeviceSession,
  DeviceSessionRequest,
} from '../device/device-provider.js';

const MAX_CONTROL_RESPONSE_CHARS = 1_000_000;
const MAX_SOURCE_CHARS = 5_000_000;
const MAX_SCREENSHOT_BASE64_CHARS = 24_000_000;
const MAX_LOG_RESPONSE_CHARS = 5_000_000;
const MAX_LOG_TYPES = 50;
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_MESSAGE_CHARS = 100_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_COORDINATE = 20_000;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function defaultCapabilities(platform: DevicePlatform): Record<string, unknown> {
  if (platform === 'android') {
    return {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:newCommandTimeout': 60,
    };
  }
  return {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:newCommandTimeout': 60,
  };
}

export class HttpAppiumDeviceProvider implements DeviceProvider {
  readonly name = 'appium-w3c-http';
  private readonly baseUrl: string;

  constructor(endpoint: string, private readonly token?: string) {
    if (!isSecureServiceEndpoint(endpoint)) {
      throw new Error('Appium endpoint must use HTTPS unless it is localhost/loopback');
    }
    this.baseUrl = endpoint.replace(/\/+$/, '');
  }

  async startSession(request: DeviceSessionRequest): Promise<DeviceSession> {
    const capabilities = {
      ...defaultCapabilities(request.platform),
      ...(request.capabilities ?? {}),
      platformName: request.platform === 'android' ? 'Android' : 'iOS',
    };
    const payload = await this.fetchJson('/session', {
      method: 'POST',
      body: JSON.stringify({ capabilities: { alwaysMatch: capabilities } }),
    }, MAX_CONTROL_RESPONSE_CHARS);
    const root = record(payload);
    const value = record(root?.value);
    const sessionId = typeof value?.sessionId === 'string'
      ? value.sessionId
      : typeof root?.sessionId === 'string'
        ? root.sessionId
        : undefined;
    if (!sessionId || sessionId.length > 500) throw new Error('Appium did not return a valid W3C session id');
    return { id: sessionId, platform: request.platform };
  }

  async getPageSource(session: DeviceSession): Promise<string> {
    const payload = await this.fetchJson(`/session/${encodeURIComponent(session.id)}/source`, {
      method: 'GET',
    }, MAX_SOURCE_CHARS + 100_000);
    const value = record(payload)?.value;
    if (typeof value !== 'string') throw new Error('Appium page source response did not contain a string value');
    if (value.length > MAX_SOURCE_CHARS) throw new Error('Appium page source exceeded the 5,000,000 character limit');
    return value;
  }

  async getScreenshotBase64(session: DeviceSession): Promise<string> {
    const payload = await this.fetchJson(`/session/${encodeURIComponent(session.id)}/screenshot`, {
      method: 'GET',
    }, MAX_SCREENSHOT_BASE64_CHARS + 100_000);
    const value = record(payload)?.value;
    if (typeof value !== 'string' || value.length === 0) throw new Error('Appium screenshot response did not contain base64 image data');
    if (value.length > MAX_SCREENSHOT_BASE64_CHARS) throw new Error('Appium screenshot exceeded the 24,000,000 character base64 limit');
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(value)) throw new Error('Appium screenshot response was not valid base64 text');
    return value.replace(/\s+/g, '');
  }

  async queryApplicationState(session: DeviceSession, applicationId: string): Promise<number | undefined> {
    if (!applicationId || applicationId.length > 300) return undefined;
    try {
      const args = session.platform === 'ios'
        ? [{ bundleId: applicationId }]
        : [{ appId: applicationId }];
      const payload = await this.fetchJson(`/session/${encodeURIComponent(session.id)}/execute/sync`, {
        method: 'POST',
        body: JSON.stringify({ script: 'mobile: queryAppState', args }),
      }, MAX_CONTROL_RESPONSE_CHARS);
      const value = record(payload)?.value;
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async getActiveApplicationId(session: DeviceSession): Promise<string | undefined> {
    if (session.platform !== 'ios') return undefined;
    try {
      const payload = await this.fetchJson(`/session/${encodeURIComponent(session.id)}/execute/sync`, {
        method: 'POST',
        body: JSON.stringify({ script: 'mobile: activeAppInfo', args: [] }),
      }, MAX_CONTROL_RESPONSE_CHARS);
      const value = record(record(payload)?.value);
      const bundleId = typeof value?.bundleId === 'string' ? value.bundleId.trim() : '';
      return bundleId.length > 0 && bundleId.length <= 300 ? bundleId : undefined;
    } catch {
      return undefined;
    }
  }

  async getAvailableLogTypes(session: DeviceSession): Promise<string[]> {
    try {
      const payload = await this.fetchJson(`/session/${encodeURIComponent(session.id)}/se/log/types`, {
        method: 'GET',
      }, MAX_CONTROL_RESPONSE_CHARS);
      const value = record(payload)?.value;
      if (!Array.isArray(value)) return [];
      return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 100))]
        .slice(0, MAX_LOG_TYPES);
    } catch {
      return [];
    }
  }

  async getLogEntries(session: DeviceSession, logType: string): Promise<DeviceLogEntry[]> {
    if (!logType || logType.length > 100) return [];
    try {
      const payload = await this.fetchJson(`/session/${encodeURIComponent(session.id)}/se/log`, {
        method: 'POST',
        body: JSON.stringify({ type: logType }),
      }, MAX_LOG_RESPONSE_CHARS);
      const value = record(payload)?.value;
      if (!Array.isArray(value)) return [];
      const entries: DeviceLogEntry[] = [];
      for (const item of value.slice(0, MAX_LOG_ENTRIES)) {
        const source = record(item);
        const message = typeof source?.message === 'string'
          ? source.message
          : typeof source?.text === 'string'
            ? source.text
            : undefined;
        if (!message || message.length > MAX_LOG_MESSAGE_CHARS) continue;
        entries.push({
          message,
          level: typeof source?.level === 'string' && source.level.length <= 40 ? source.level : undefined,
          timestamp: typeof source?.timestamp === 'number' && Number.isFinite(source.timestamp) ? source.timestamp : undefined,
        });
      }
      return entries;
    } catch {
      return [];
    }
  }

  async tap(session: DeviceSession, x: number, y: number): Promise<void> {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > MAX_COORDINATE || y > MAX_COORDINATE) {
      throw new Error('device tap coordinates are outside the bounded viewport range');
    }
    const sessionPath = `/session/${encodeURIComponent(session.id)}`;
    await this.fetchJson(`${sessionPath}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        actions: [{
          type: 'pointer',
          id: 'aiqa-touch',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x, y, origin: 'viewport' },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      }),
    }, MAX_CONTROL_RESPONSE_CHARS);
    await this.fetchJson(`${sessionPath}/actions`, { method: 'DELETE' }, MAX_CONTROL_RESPONSE_CHARS).catch(() => undefined);
  }

  async stopSession(session: DeviceSession): Promise<void> {
    await this.fetchJson(`/session/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
    }, MAX_CONTROL_RESPONSE_CHARS).catch((error: unknown) => {
      throw new Error(`Appium session cleanup failed: ${String(error)}`);
    });
  }

  private async fetchJson(path: string, init: RequestInit, maxChars: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      if (text.length > maxChars) throw new Error(`Appium response exceeded ${maxChars} characters`);
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Appium returned non-JSON HTTP ${response.status}`);
      }
      const value = record(record(payload)?.value);
      if (!response.ok || typeof value?.error === 'string') {
        const message = typeof value?.message === 'string' ? value.message : `HTTP ${response.status}`;
        throw new Error(`Appium command failed: ${message}`);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}
