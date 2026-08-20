import type { DeviceLogEntry, DevicePlatform } from './device-provider.js';

export type DeviceLogDefectKind = 'crash-log' | 'anr-log';

export interface DeviceLogDefectSignal {
  kind: DeviceLogDefectKind;
  signature: 'android-fatal-runtime' | 'android-anr-log' | 'ios-crash-report';
  entriesConsidered: number;
}

const ANDROID_FATAL = /FATAL EXCEPTION|Fatal signal \d+|Process has died|force finishing activity/i;
const ANDROID_ANR = /ANR in |Application Not Responding|Input dispatching timed out/i;
const IOS_CRASH = /Exception Type:|Termination Reason:|Triggered by Thread:|Exception Codes:/i;

function batchContains(entries: DeviceLogEntry[], pattern: RegExp): boolean {
  return entries.some((entry) => pattern.test(entry.message));
}

function mentionsApplication(entries: DeviceLogEntry[], applicationId: string): boolean {
  const needle = applicationId.toLowerCase();
  return entries.some((entry) => entry.message.toLowerCase().includes(needle));
}

export function detectDeviceLogDefect(
  entries: DeviceLogEntry[],
  platform: DevicePlatform,
  applicationId: string,
  logType: string,
): DeviceLogDefectSignal | undefined {
  if (!applicationId || entries.length === 0 || !mentionsApplication(entries, applicationId)) return undefined;
  const entriesConsidered = Math.min(entries.length, 500);

  if (platform === 'android' && logType.toLowerCase() === 'logcat') {
    if (batchContains(entries, ANDROID_ANR)) {
      return { kind: 'anr-log', signature: 'android-anr-log', entriesConsidered };
    }
    if (batchContains(entries, ANDROID_FATAL)) {
      return { kind: 'crash-log', signature: 'android-fatal-runtime', entriesConsidered };
    }
    return undefined;
  }

  if (platform === 'ios' && logType.toLowerCase() === 'crashlog' && batchContains(entries, IOS_CRASH)) {
    return { kind: 'crash-log', signature: 'ios-crash-report', entriesConsidered };
  }

  return undefined;
}
