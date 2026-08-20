import type { CandidateDecision, ExplorationCandidate, RiskMode } from '../core/types.js';
import { HumanLikePolicy } from '../planning/human-like-policy.js';
import type { DeviceElementCandidate } from './device-page-source.js';

const DEVICE_HARD_BLOCK = [
  /\b(delete|destroy|remove|erase|close)\s+(account|profile|data)\b/i,
  /\b(exit|quit|close)\s+(app|application)\b/i,
  /\b(pay|payment|purchase|buy|checkout|place order|confirm order|transfer|send money|withdraw|deposit|payout)\b/i,
  /\b(publish|deploy|production|send email|send sms|send notification|webhook|share externally)\b/i,
  /\b(install|uninstall|factory reset|wipe device|reset device)\b/i,
  /\b(allow|deny)\b.*\b(permission|camera|microphone|photos?|contacts?|location|bluetooth|notifications?)\b/i,
  /\b(permission|camera|microphone|photos?|contacts?|location|bluetooth)\b.*\b(allow|deny)\b/i,
  /(刪除|删除|移除|清除|註銷|注销).*(帳號|账号|資料|数据)/,
  /(退出|關閉|关闭).*(應用程式|应用程序|應用|应用|App|APP)/,
  /(付款|支付|購買|购买|結帳|结账|下單|下单|轉帳|转账|匯款|汇款|提款|存款)/,
  /(發布|发布|部署|上線|上线|傳送簡訊|发送短信|發送通知|发送通知)/,
  /(安裝|安装|解除安裝|卸載|卸载|恢復原廠|恢复出厂|清除裝置|清除设备)/,
  /(允許|允许|拒絕|拒绝).*(權限|权限|相機|相机|麥克風|麦克风|照片|聯絡人|联系人|位置|藍牙|蓝牙|通知)/,
];

const DEVICE_MEDIUM = [
  /\b(save|submit|create|update|register|sign up|login|log in|sign in|logout|log out|confirm)\b/i,
  /(儲存|保存|提交|建立|创建|更新|註冊|注册|登入|登錄|登录|登出|確認|确认)/,
];

function normalizeSafetyText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class DeviceRiskPolicy {
  constructor(private readonly browserPolicy: HumanLikePolicy = new HumanLikePolicy()) {}

  evaluate(candidate: DeviceElementCandidate, riskMode: RiskMode): CandidateDecision {
    const text = normalizeSafetyText(candidate.label);
    if (DEVICE_HARD_BLOCK.some((pattern) => pattern.test(text))) {
      return {
        risk: 'blocked',
        allowed: false,
        interestScore: 0,
        reasons: ['mobile action has destructive, financial, permission, installation, app-exit, or external-side-effect semantics'],
      };
    }

    const mapped: ExplorationCandidate = {
      id: `device:${candidate.id}`,
      kind: 'button',
      label: text,
      locatorIndex: 0,
      tagName: candidate.className || 'device-control',
      role: 'button',
      type: 'button',
    };
    const base = this.browserPolicy.evaluate(mapped, riskMode);
    if (base.risk === 'blocked') return base;

    if (DEVICE_MEDIUM.some((pattern) => pattern.test(text))) {
      const allowed = riskMode === 'standard';
      return {
        risk: 'medium',
        allowed,
        interestScore: Math.max(base.interestScore, 18),
        reasons: [...base.reasons, 'mobile label suggests state-changing or session-changing action', ...(allowed ? [] : ['blocked by safe risk mode'])],
      };
    }

    return base;
  }
}
