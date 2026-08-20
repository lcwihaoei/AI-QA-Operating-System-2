import type { CandidateDecision, ExplorationCandidate, RiskMode } from '../core/types.js';

const BLOCKED_TERMS = [
  'delete account', 'remove account', 'close account', 'destroy', 'withdraw', 'transfer', 'send money',
  'pay now', 'purchase', 'buy now', 'place order', 'confirm order', 'checkout', 'publish', 'deploy',
];
const SENSITIVE_FIELD_TERMS = [
  'credit card', 'card number', 'cvv', 'cvc', 'expiry', 'expiration', 'iban', 'bank account', 'routing',
  'social security', 'ssn', 'api key', 'secret', 'access token', 'auth token', 'one-time code', 'one time code',
  'otp', '2fa', 'verification code',
];
const MEDIUM_BUTTON_TERMS = [
  'save', 'submit', 'create', 'update', 'register', 'sign up', 'login', 'log in', 'sign in', 'logout', 'log out',
];
const SESSION_LINK_TERMS = ['logout', 'log out', 'sign out'];
const HIGH_INTEREST_TERMS = [
  'menu', 'next', 'previous', 'back', 'settings', 'security', 'profile', 'help', 'details', 'filter', 'sort',
  'expand', 'collapse', 'theme', 'dark', 'light', 'language', 'tab', 'more', 'forgot', 'reset', 'login', 'log in',
  'sign in', 'register', 'sign up', 'search', 'email', 'username',
];

export class HumanLikePolicy {
  evaluate(candidate: ExplorationCandidate, riskMode: RiskMode): CandidateDecision {
    const text = [
      candidate.label,
      candidate.href,
      candidate.formAction,
      candidate.name,
      candidate.placeholder,
      candidate.autocomplete,
    ].filter(Boolean).join(' ').toLowerCase();
    const reasons: string[] = [];

    if (BLOCKED_TERMS.some((term) => text.includes(term))) {
      return { risk: 'blocked', allowed: false, interestScore: 0, reasons: ['irreversible or financially sensitive action'] };
    }

    if (candidate.kind === 'field') {
      const type = (candidate.type || 'text').toLowerCase();
      if (type === 'file' || SENSITIVE_FIELD_TERMS.some((term) => text.includes(term))) {
        return { risk: 'blocked', allowed: false, interestScore: 0, reasons: ['sensitive credential, financial, verification, or file field'] };
      }
    }

    let risk: CandidateDecision['risk'] = 'low';
    if (candidate.kind === 'button' && candidate.type?.toLowerCase() === 'submit') {
      risk = 'medium';
      reasons.push('form submission can mutate server state');
    }
    if (candidate.kind === 'button' && MEDIUM_BUTTON_TERMS.some((term) => text.includes(term))) {
      risk = 'medium';
      reasons.push('state-changing or session-changing button semantics');
    }
    if (candidate.kind === 'link' && SESSION_LINK_TERMS.some((term) => text.includes(term))) {
      risk = 'medium';
      reasons.push('session-changing navigation');
    }
    if (candidate.kind === 'field') {
      const type = (candidate.type || 'text').toLowerCase();
      if (candidate.tagName.toLowerCase() === 'select' || ['password', 'checkbox', 'radio'].includes(type)) {
        risk = 'medium';
        reasons.push('field can affect authentication or stateful selection');
      }
    }

    let interestScore = candidate.kind === 'link' ? 18 : candidate.kind === 'field' ? 16 : 12;
    if (HIGH_INTEREST_TERMS.some((term) => text.includes(term))) {
      interestScore += 22;
      reasons.push('high-value exploratory control');
    }
    if (!candidate.label.trim() && candidate.kind !== 'field') {
      interestScore -= 8;
      reasons.push('unnamed control has low interpretability');
    }

    const allowed = risk === 'low' || riskMode === 'standard';
    if (!allowed) reasons.push('blocked by safe risk mode');
    if (reasons.length === 0) reasons.push('low-risk exploratory candidate');

    return { risk, allowed, interestScore: Math.max(0, interestScore), reasons };
  }
}
