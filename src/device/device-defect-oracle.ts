import type { DevicePlatform } from './device-provider.js';

export type DeviceDefectKind = 'crash-dialog' | 'anr-dialog';

export interface DeviceDefectSignal {
  kind: DeviceDefectKind;
  signature: 'android-crash-dialog' | 'android-anr-dialog';
}

const ANDROID_CRASH_PATTERNS = [
  /\bkeeps stopping\b/i,
  /\bhas stopped\b/i,
  /\bstopped working\b/i,
  /屢次停止運作/,
  /一直停止運作/,
  /已停止運作/,
  /停止運作/,
  /停止运行/,
];

const ANDROID_ANR_PATTERNS = [
  /\bisn't responding\b/i,
  /\bis not responding\b/i,
  /\bnot responding\b/i,
  /應用程式沒有回應/,
  /應用沒有回應/,
  /沒有回應/,
  /应用程序无响应/,
  /应用无响应/,
  /无响应/,
];

export function detectDeviceDefect(source: string, platform: DevicePlatform): DeviceDefectSignal | undefined {
  if (platform !== 'android') return undefined;
  if (ANDROID_ANR_PATTERNS.some((pattern) => pattern.test(source))) {
    return { kind: 'anr-dialog', signature: 'android-anr-dialog' };
  }
  if (ANDROID_CRASH_PATTERNS.some((pattern) => pattern.test(source))) {
    return { kind: 'crash-dialog', signature: 'android-crash-dialog' };
  }
  return undefined;
}
