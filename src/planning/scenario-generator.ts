import type { ExplorationCandidate } from '../core/types.js';
import type { PageArchetype, PageStateSnapshot } from './page-state-analyzer.js';

export interface ScenarioIntent {
  id: string;
  label: string;
  priority: number;
  keywords: string[];
}

const SCENARIOS: Record<PageArchetype, ScenarioIntent[]> = {
  authentication: [
    { id: 'auth-entry', label: 'Authentication entry and recovery', priority: 100, keywords: ['login', 'log in', 'sign in', 'register', 'sign up', 'forgot', 'reset', 'password', 'email', 'username'] },
  ],
  settings: [
    { id: 'account-settings', label: 'Account and settings controls', priority: 92, keywords: ['settings', 'profile', 'security', 'password', 'preference', 'theme', 'language', 'appearance'] },
  ],
  admin: [
    { id: 'admin-management', label: 'Admin navigation and management surfaces', priority: 88, keywords: ['admin', 'dashboard', 'users', 'roles', 'permissions', 'edit', 'create', 'manage', 'moderation'] },
  ],
  commerce: [
    { id: 'commerce-browse', label: 'Commerce browsing and order surfaces', priority: 72, keywords: ['product', 'pricing', 'cart', 'order', 'billing', 'checkout'] },
  ],
  search: [
    { id: 'search-discovery', label: 'Search, filter and result exploration', priority: 86, keywords: ['search', 'query', 'filter', 'sort', 'results'] },
  ],
  form: [
    { id: 'form-validation', label: 'Form field and validation states', priority: 82, keywords: ['name', 'email', 'username', 'password', 'required', 'submit', 'save', 'continue', 'next'] },
  ],
  content: [
    { id: 'content-navigation', label: 'Content navigation and detail discovery', priority: 58, keywords: ['next', 'previous', 'details', 'more', 'help', 'about', 'learn'] },
  ],
  generic: [
    { id: 'generic-navigation', label: 'General navigation and interaction discovery', priority: 45, keywords: ['home', 'menu', 'next', 'help', 'more'] },
  ],
};

export class ScenarioGenerator {
  generate(state: PageStateSnapshot): ScenarioIntent[] {
    const byId = new Map<string, ScenarioIntent>();
    for (const archetype of state.archetypes) {
      for (const scenario of SCENARIOS[archetype]) {
        const existing = byId.get(scenario.id);
        if (!existing || scenario.priority > existing.priority) byId.set(scenario.id, scenario);
      }
    }
    if (byId.size === 0) byId.set('generic-navigation', SCENARIOS.generic[0]!);
    return [...byId.values()].sort((a, b) => b.priority - a.priority);
  }

  scoreCandidate(candidate: ExplorationCandidate, scenarios: ScenarioIntent[]): { boost: number; reasons: string[] } {
    const text = [candidate.label, candidate.href, candidate.name, candidate.placeholder, candidate.type]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    let boost = 0;
    const reasons: string[] = [];

    for (const scenario of scenarios) {
      const matches = scenario.keywords.filter((keyword) => text.includes(keyword));
      if (matches.length === 0) continue;
      const scenarioBoost = Math.min(26, 6 * matches.length + Math.round(scenario.priority / 20));
      boost += scenarioBoost;
      reasons.push(`scenario ${scenario.id}: ${matches.slice(0, 3).join(', ')}`);
    }

    return { boost: Math.min(40, boost), reasons };
  }
}
