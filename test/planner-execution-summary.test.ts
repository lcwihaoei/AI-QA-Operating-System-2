import { describe, expect, it } from 'vitest';
import type { ModelExecutionStatus } from '../src/contracts/quality-contracts.js';
import type { QaEvent } from '../src/core/types.js';
import { summarizePlannerExecution } from '../src/planning/planner-execution-summary.js';

function planner(url: string, status: ModelExecutionStatus): QaEvent {
  return {
    timestamp: new Date().toISOString(),
    kind: 'planner',
    url,
    message: 'Planner ranked 4 candidates',
    details: { modelStatus: status },
  };
}

const notConfigured: ModelExecutionStatus = {
  configured: false,
  attempted: false,
  used: false,
  repairAttempted: false,
  fallbackUsed: false,
  outcome: 'not-configured',
};

describe('planner execution summary', () => {
  it('reports heuristic runs as not configured', () => {
    expect(summarizePlannerExecution([planner('https://example.com/', notConfigured)])).toMatchObject({
      configured: false,
      status: 'not-configured',
      pagesObserved: 1,
      pagesAttempted: 0,
      pagesModelUsed: 0,
      pagesFallback: 0,
    });
  });

  it('counts unique pages rather than repeated interaction rounds', () => {
    const used: ModelExecutionStatus = {
      configured: true,
      attempted: true,
      used: true,
      repairAttempted: false,
      fallbackUsed: false,
      outcome: 'used',
      provider: 'minimax:MiniMax-M3',
    };
    const summary = summarizePlannerExecution([
      planner('https://example.com/settings?round=1', used),
      planner('https://example.com/settings?round=2', used),
      planner('https://example.com/profile', used),
    ]);
    expect(summary).toMatchObject({ status: 'active', pagesObserved: 2, pagesAttempted: 2, pagesModelUsed: 2, pagesFallback: 0 });
    expect(summary.providers).toEqual(['minimax:MiniMax-M3']);
  });

  it('makes repaired use and partial fallback visible', () => {
    const repaired: ModelExecutionStatus = {
      configured: true,
      attempted: true,
      used: true,
      repairAttempted: true,
      fallbackUsed: false,
      outcome: 'repaired-and-used',
      provider: 'minimax:MiniMax-M3',
    };
    const fallback: ModelExecutionStatus = {
      configured: true,
      attempted: true,
      used: false,
      repairAttempted: true,
      fallbackUsed: true,
      outcome: 'fallback',
      provider: 'minimax:MiniMax-M3',
      error: 'schema-invalid',
    };
    expect(summarizePlannerExecution([
      planner('https://example.com/', repaired),
      planner('https://example.com/settings', fallback),
    ])).toMatchObject({
      status: 'partial-fallback',
      pagesAttempted: 2,
      pagesModelUsed: 1,
      pagesFallback: 1,
      repairAttempts: 2,
      failedCalls: 1,
    });
  });

  it('reports configured models with no successful model pages as unavailable', () => {
    const fallback: ModelExecutionStatus = {
      configured: true,
      attempted: true,
      used: false,
      repairAttempted: false,
      fallbackUsed: true,
      outcome: 'fallback',
      error: 'transport-timeout',
    };
    expect(summarizePlannerExecution([planner('https://example.com/', fallback)]).status).toBe('unavailable');
  });
});
