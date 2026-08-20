import { describe, expect, it } from 'vitest';
import { detectDeviceLogDefect } from '../src/device/device-log-oracle.js';

const appId = 'com.example.app';

describe('device log defect oracle', () => {
  it('detects Android fatal runtime only when the new log batch names the target app', () => {
    const signal = detectDeviceLogDefect([
      { message: `E/AndroidRuntime: FATAL EXCEPTION: main Process: ${appId}, PID: 123` },
    ], 'android', appId, 'logcat');
    expect(signal).toMatchObject({ kind: 'crash-log', signature: 'android-fatal-runtime', entriesConsidered: 1 });

    expect(detectDeviceLogDefect([
      { message: 'E/AndroidRuntime: FATAL EXCEPTION: main Process: com.other.app, PID: 456' },
    ], 'android', appId, 'logcat')).toBeUndefined();
  });

  it('detects Android ANR only from logcat and with target-app evidence', () => {
    expect(detectDeviceLogDefect([
      { message: `ActivityManager: ANR in ${appId} Input dispatching timed out` },
    ], 'android', appId, 'logcat')).toMatchObject({ kind: 'anr-log', signature: 'android-anr-log' });

    expect(detectDeviceLogDefect([
      { message: `ActivityManager: ANR in ${appId} Input dispatching timed out` },
    ], 'android', appId, 'server')).toBeUndefined();
  });

  it('accepts iOS crash-report signatures only from crashlog and when the bundle is present', () => {
    const iosBundle = 'com.example.ios';
    const entries = [
      { message: `Identifier: ${iosBundle}\nException Type: EXC_CRASH (SIGABRT)\nTriggered by Thread: 0` },
    ];
    expect(detectDeviceLogDefect(entries, 'ios', iosBundle, 'crashlog')).toMatchObject({
      kind: 'crash-log',
      signature: 'ios-crash-report',
    });
    expect(detectDeviceLogDefect(entries, 'ios', iosBundle, 'syslog')).toBeUndefined();
  });

  it('does not produce a finding from generic errors without a deterministic crash/ANR signature', () => {
    expect(detectDeviceLogDefect([
      { level: 'SEVERE', message: `${appId}: network request failed with HTTP 500` },
    ], 'android', appId, 'logcat')).toBeUndefined();
  });
});
