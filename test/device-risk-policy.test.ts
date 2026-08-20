import { describe, expect, it } from 'vitest';
import { DeviceRiskPolicy } from '../src/device/device-risk-policy.js';
import type { DeviceElementCandidate } from '../src/device/device-page-source.js';

function candidate(label: string): DeviceElementCandidate {
  return {
    id: label,
    platform: 'android',
    label,
    className: 'android.widget.Button',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    centerX: 50,
    centerY: 25,
  };
}

describe('DeviceRiskPolicy', () => {
  const policy = new DeviceRiskPolicy();

  it.each([
    'deleteAccount',
    'com.example:id/payNow',
    'Transfer Money',
    'Allow Camera Permission',
    'Uninstall App',
    'Exit App',
    'quitApplication',
    '刪除帳號',
    '付款',
    '允許相機權限',
    '退出應用程式',
    '关闭应用',
  ])('permanently blocks dangerous mobile control %s', (label) => {
    const safe = policy.evaluate(candidate(label), 'safe');
    const standard = policy.evaluate(candidate(label), 'standard');
    expect(safe.allowed).toBe(false);
    expect(standard.allowed).toBe(false);
    expect(safe.risk).toBe('blocked');
  });

  it('keeps ordinary Settings navigation low risk', () => {
    const decision = policy.evaluate(candidate('Settings'), 'safe');
    expect(decision.allowed).toBe(true);
    expect(decision.risk).toBe('low');
  });

  it('keeps Save medium and therefore blocked in safe mode', () => {
    expect(policy.evaluate(candidate('Save'), 'safe')).toMatchObject({ allowed: false, risk: 'medium' });
    expect(policy.evaluate(candidate('Save'), 'standard')).toMatchObject({ allowed: true, risk: 'medium' });
  });
});
