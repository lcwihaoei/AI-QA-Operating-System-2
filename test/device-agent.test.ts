import { describe, expect, it, vi } from 'vitest';
import { DeviceAgent } from '../src/agents/device-agent.js';
import { findingsFromEvents } from '../src/reporting/bug-reporter.js';
import type { DeviceProvider } from '../src/device/device-provider.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=';

function provider(overrides: Partial<DeviceProvider> = {}): DeviceProvider {
  return {
    name: 'mock-device',
    startSession: vi.fn().mockResolvedValue({ id: 'session-1', platform: 'android' }),
    getPageSource: vi.fn().mockResolvedValue('<hierarchy><node/></hierarchy>'),
    getScreenshotBase64: vi.fn().mockResolvedValue(png),
    queryApplicationState: vi.fn().mockResolvedValue(4),
    getActiveApplicationId: vi.fn().mockResolvedValue(undefined),
    getAvailableLogTypes: vi.fn().mockResolvedValue([]),
    getLogEntries: vi.fn().mockResolvedValue([]),
    tap: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const inAppSettings = `<hierarchy>
  <node class="android.widget.Button" package="com.example.app" text="Settings" clickable="true" enabled="true" bounds="[0,0][200,80]" />
</hierarchy>`;

describe('DeviceAgent', () => {
  it('captures smoke evidence and closes the Appium session', async () => {
    const deviceProvider = provider();
    const evidence = { writePngBase64: vi.fn().mockResolvedValue('/tmp/device.png') } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({
      mode: 'smoke',
      platform: 'android',
      capabilities: { 'appium:deviceName': 'QA Pixel' },
    });
    expect(result.summary).toMatchObject({
      enabled: true,
      mode: 'smoke',
      platform: 'android',
      provider: 'mock-device',
      sessionStarted: true,
      screenshotCaptured: true,
      actions: 0,
      appStateChecks: 0,
      cleanupAttempted: true,
      cleanupFailed: false,
    });
    expect(result.summary.pageSourceChars).toBeGreaterThan(0);
    expect(result.summary.elementEstimate).toBeGreaterThanOrEqual(1);
    expect(deviceProvider.stopSession).toHaveBeenCalledTimes(1);
    expect(deviceProvider.tap).not.toHaveBeenCalled();
    expect(evidence.writePngBase64).toHaveBeenCalledWith(png, 'device-android-smoke');
    expect(JSON.stringify(result.events)).not.toContain('session-1');
  });

  it('explores only allowed in-app controls within the mobile action budget', async () => {
    const first = `<hierarchy>
      <node class="android.widget.Button" package="com.example.app" text="Settings" clickable="true" enabled="true" bounds="[0,0][200,80]" />
      <node class="android.widget.Button" package="com.example.app" resource-id="com.example:id/deleteAccount" clickable="true" enabled="true" bounds="[0,100][200,180]" />
      <node class="android.widget.Button" package="com.android.permissioncontroller" text="Only this time" clickable="true" enabled="true" bounds="[0,200][200,280]" />
    </hierarchy>`;
    const second = `<hierarchy>
      <node class="android.widget.Button" package="com.example.app" text="Help" clickable="true" enabled="true" bounds="[0,0][200,80]" />
      <node class="android.widget.Button" package="com.example.app" text="Pay Now" clickable="true" enabled="true" bounds="[0,100][200,180]" />
    </hierarchy>`;
    const third = '<hierarchy><node class="android.widget.TextView" package="com.example.app" text="Done" clickable="false" bounds="[0,0][200,80]" /></hierarchy>';
    const tap = vi.fn().mockResolvedValue(undefined);
    const deviceProvider = provider({
      getPageSource: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third),
      tap,
    });
    const evidence = { writePngBase64: vi.fn().mockResolvedValue('/tmp/device.png') } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({
      mode: 'explore',
      platform: 'android',
      riskMode: 'safe',
      maxActions: 5,
      capabilities: { 'appium:appPackage': 'com.example.app' },
    });
    expect(result.summary.actions).toBe(2);
    expect(result.summary.candidatesObserved).toBe(5);
    expect(result.summary.blockedCandidates).toBe(2);
    expect(result.summary.outsideAppCandidates).toBe(1);
    expect(result.summary.appBoundaryDeclared).toBe(true);
    expect(result.summary.appBoundaryObserved).toBe(false);
    expect(result.summary.appStateChecks).toBe(3);
    expect(tap).toHaveBeenCalledTimes(2);
    expect(result.events.some((event) => event.kind === 'action' && event.message.includes('deleteAccount'))).toBe(false);
    expect(result.events.some((event) => event.kind === 'action' && event.message.includes('Pay Now'))).toBe(false);
    expect(result.events.some((event) => event.kind === 'action' && event.message.includes('Only this time'))).toBe(false);
    expect(deviceProvider.stopSession).toHaveBeenCalledTimes(1);
  });

  it('uses verified iOS active-app identity when XCUI candidates do not expose bundle ids', async () => {
    const first = `<AppiumAUT>
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="Settings" label="Settings" enabled="true" visible="true" x="20" y="50" width="120" height="44" />
    </AppiumAUT>`;
    const second = `<AppiumAUT>
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="Help" label="Help" enabled="true" visible="true" x="20" y="50" width="120" height="44" />
    </AppiumAUT>`;
    const active = vi.fn().mockResolvedValueOnce('com.example.ios').mockResolvedValueOnce('com.apple.springboard');
    const tap = vi.fn().mockResolvedValue(undefined);
    const deviceProvider = provider({
      startSession: vi.fn().mockResolvedValue({ id: 'ios-1', platform: 'ios' }),
      getPageSource: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      getActiveApplicationId: active,
      queryApplicationState: vi.fn().mockResolvedValue(4),
      tap,
    });
    const evidence = { writePngBase64: vi.fn().mockResolvedValue('/tmp/ios.png') } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({
      mode: 'explore',
      platform: 'ios',
      maxActions: 5,
      capabilities: { 'appium:bundleId': 'com.example.ios' },
    });
    expect(result.summary.actions).toBe(1);
    expect(tap).toHaveBeenCalledTimes(1);
    expect(result.events.some((event) => event.kind === 'planner' && event.details?.activeApplicationVerified === true)).toBe(true);
    expect(result.events.some((event) => event.message.includes('another application became active'))).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain('com.example.ios');
    expect(JSON.stringify(result.events)).not.toContain('com.apple.springboard');
    expect(deviceProvider.stopSession).toHaveBeenCalledTimes(1);
  });

  it('reports High when an allowed interaction changes the target app from foreground to not running', async () => {
    const queryApplicationState = vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(1);
    const tap = vi.fn().mockResolvedValue(undefined);
    const deviceProvider = provider({ getPageSource: vi.fn().mockResolvedValueOnce(inAppSettings), queryApplicationState, tap });
    const evidence = { writePngBase64: vi.fn().mockResolvedValue('/tmp/terminated.png') } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({
      mode: 'explore', platform: 'android', riskMode: 'safe', maxActions: 5,
      capabilities: { 'appium:appPackage': 'com.example.app' },
    });
    expect(result.summary).toMatchObject({ actions: 1, appStateChecks: 2, appTerminationFindings: 1, crashDialogFindings: 0, cleanupAttempted: true });
    expect(tap).toHaveBeenCalledTimes(1);
    const assertion = result.events.find((event) => event.kind === 'assertion');
    expect(assertion?.details).toMatchObject({ deviceDefect: 'app-terminated', severityHint: 'high', confidence: 'high', appState: 1 });
    const finding = findingsFromEvents(result.events)[0];
    expect(finding).toMatchObject({ severity: 'high', title: 'Mobile application terminated unexpectedly' });
    expect(finding?.evidence).toEqual(['/tmp/terminated.png']);
    expect(finding?.reproduction.some((step) => step.includes('Settings'))).toBe(true);
    expect(deviceProvider.stopSession).toHaveBeenCalledTimes(1);
  });

  it('stops without a product finding when an allowed interaction backgrounds the app', async () => {
    const deviceProvider = provider({
      getPageSource: vi.fn().mockResolvedValueOnce(inAppSettings),
      queryApplicationState: vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(3),
    });
    const evidence = { writePngBase64: vi.fn().mockResolvedValue('/tmp/device.png') } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({
      mode: 'explore', platform: 'android', capabilities: { 'appium:appPackage': 'com.example.app' },
    });
    expect(result.summary.actions).toBe(1);
    expect(result.summary.appTerminationFindings).toBe(0);
    expect(result.events.some((event) => event.kind === 'assertion')).toBe(false);
    expect(findingsFromEvents(result.events)).toHaveLength(0);
  });

  it('reports an Android crash dialog after an allowed interaction without persisting source XML', async () => {
    const crashSource = `<hierarchy>
      <node class="android.widget.TextView" package="android" text="Example keeps stopping" clickable="false" bounds="[0,0][300,80]" />
      <node class="android.widget.Button" package="android" text="App info" clickable="true" bounds="[0,100][200,180]" />
    </hierarchy>`;
    const deviceProvider = provider({
      getPageSource: vi.fn().mockResolvedValueOnce(inAppSettings).mockResolvedValueOnce(crashSource),
      queryApplicationState: vi.fn().mockResolvedValue(4),
    });
    const evidence = { writePngBase64: vi.fn().mockResolvedValue('/tmp/crash.png') } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({
      mode: 'explore', platform: 'android', capabilities: { 'appium:appPackage': 'com.example.app' },
    });
    expect(result.summary).toMatchObject({ actions: 1, crashDialogFindings: 1 });
    const assertion = result.events.find((event) => event.kind === 'assertion');
    expect(assertion?.details).toMatchObject({ deviceDefect: 'crash-dialog', defectSignature: 'android-crash-dialog', severityHint: 'high', sourcePersisted: false });
    expect(JSON.stringify(result.events)).not.toContain('Example keeps stopping');
    const finding = findingsFromEvents(result.events)[0];
    expect(finding).toMatchObject({ severity: 'high', title: 'Mobile crash dialog detected' });
    expect(finding?.evidence).toEqual(['/tmp/crash.png']);
  });

  it('refuses exploration before starting a session when no app boundary is declared', async () => {
    const deviceProvider = provider();
    const evidence = { writePngBase64: vi.fn() } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({ mode: 'explore', platform: 'android' });
    expect(result.summary.toolingError).toContain('appium:appPackage');
    expect(result.summary.sessionStarted).toBe(false);
    expect(deviceProvider.startSession).not.toHaveBeenCalled();
  });

  it('stops without tapping when the current source does not prove the declared app boundary', async () => {
    const source = `<hierarchy><node class="android.widget.Button" package="com.android.settings" text="Settings" clickable="true" enabled="true" bounds="[0,0][200,80]" /></hierarchy>`;
    const tap = vi.fn().mockResolvedValue(undefined);
    const deviceProvider = provider({ getPageSource: vi.fn().mockResolvedValue(source), tap });
    const evidence = { writePngBase64: vi.fn().mockResolvedValue('/tmp/device.png') } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({
      mode: 'explore', platform: 'android', capabilities: { 'appium:appPackage': 'com.example.app' },
    });
    expect(result.summary.actions).toBe(0);
    expect(result.summary.outsideAppCandidates).toBe(1);
    expect(result.summary.appBoundaryObserved).toBe(false);
    expect(tap).not.toHaveBeenCalled();
    expect(deviceProvider.stopSession).toHaveBeenCalledTimes(1);
  });

  it('stops before tapping when the app-state oracle says the target was not foreground initially', async () => {
    const deviceProvider = provider({ queryApplicationState: vi.fn().mockResolvedValueOnce(3) });
    const evidence = { writePngBase64: vi.fn() } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({
      mode: 'explore', platform: 'android', capabilities: { 'appium:appPackage': 'com.example.app' },
    });
    expect(result.summary.appStateChecks).toBe(1);
    expect(result.summary.actions).toBe(0);
    expect(result.summary.appTerminationFindings).toBe(0);
    expect(deviceProvider.getPageSource).not.toHaveBeenCalled();
    expect(deviceProvider.tap).not.toHaveBeenCalled();
    expect(deviceProvider.stopSession).toHaveBeenCalledTimes(1);
  });

  it('still closes the session when an evidence command fails', async () => {
    const stopSession = vi.fn().mockResolvedValue(undefined);
    const deviceProvider = provider({ getScreenshotBase64: vi.fn().mockRejectedValue(new Error('screenshot failed')), stopSession });
    const evidence = { writePngBase64: vi.fn() } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({ mode: 'smoke', platform: 'android' });
    expect(result.summary.sessionStarted).toBe(true);
    expect(result.summary.screenshotCaptured).toBe(false);
    expect(result.summary.cleanupAttempted).toBe(true);
    expect(result.summary.cleanupFailed).toBe(false);
    expect(result.summary.toolingError).toContain('screenshot failed');
    expect(stopSession).toHaveBeenCalledTimes(1);
  });

  it('does nothing in off mode', async () => {
    const deviceProvider = provider();
    const evidence = { writePngBase64: vi.fn() } as any;
    const result = await new DeviceAgent(evidence, deviceProvider).run({ mode: 'off' });
    expect(result.summary.enabled).toBe(false);
    expect(deviceProvider.startSession).not.toHaveBeenCalled();
  });
});
