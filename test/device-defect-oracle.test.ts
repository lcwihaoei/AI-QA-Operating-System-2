import { describe, expect, it } from 'vitest';
import { detectDeviceDefect } from '../src/device/device-defect-oracle.js';

describe('device defect oracle', () => {
  it.each([
    ['Example keeps stopping', 'crash-dialog'],
    ['Example has stopped', 'crash-dialog'],
    ['應用程式已停止運作', 'crash-dialog'],
    ['应用停止运行', 'crash-dialog'],
    ["Example isn't responding", 'anr-dialog'],
    ['Example is not responding', 'anr-dialog'],
    ['應用程式沒有回應', 'anr-dialog'],
    ['应用无响应', 'anr-dialog'],
  ] as const)('detects Android system defect text %s', (text, kind) => {
    const source = `<hierarchy><node class="android.widget.TextView" text="${text}" /></hierarchy>`;
    expect(detectDeviceDefect(source, 'android')?.kind).toBe(kind);
  });

  it('does not infer a crash from ordinary close/help text', () => {
    const source = '<hierarchy><node text="Close menu"/><node text="Help and feedback"/></hierarchy>';
    expect(detectDeviceDefect(source, 'android')).toBeUndefined();
  });

  it('does not apply Android dialog signatures to iOS source', () => {
    expect(detectDeviceDefect('<XCUIElementTypeStaticText label="Example keeps stopping"/>', 'ios')).toBeUndefined();
  });
});
