import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding, GitHubQaSummary } from '../core/types.js';
import { buildGitHubIssuePlan } from './github-issue-plan.js';
import { GitHubRegressionMemoryStore } from './github-regression-memory.js';

export interface GitHubQaPlannerOptions {
  enabled: boolean;
  runId: string;
  runDir: string;
  findings: Finding[];
  memoryPath?: string;
  updateMemory?: boolean;
}

export interface GitHubQaPlannerResult {
  summary: GitHubQaSummary;
}

export class GitHubQaPlanner {
  async run(options: GitHubQaPlannerOptions): Promise<GitHubQaPlannerResult> {
    const summary: GitHubQaSummary = {
      enabled: options.enabled,
      memoryExisted: false,
      untracked: 0,
      newIssues: 0,
      persistent: 0,
      resolved: 0,
      memoryUpdated: false,
    };
    if (!options.enabled) return { summary };

    const memoryPath = options.memoryPath ?? '.qa-memory/github-findings.json';
    summary.memoryPath = memoryPath;
    const store = new GitHubRegressionMemoryStore(memoryPath);
    const loaded = await store.load();
    summary.memoryExisted = loaded.existed;
    if (loaded.toolingError) summary.toolingError = loaded.toolingError;

    const memoryTrusted = loaded.existed && !loaded.toolingError;
    const prior = new Map([...loaded.entries].map(([fingerprint, entry]) => [fingerprint, {
      severity: entry.severity,
      kind: entry.kind,
      title: entry.title,
    }]));
    const plan = buildGitHubIssuePlan(options.runId, options.findings, prior, memoryTrusted);
    const planPath = path.join(options.runDir, 'github-issue-plan.json');
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    summary.planPath = planPath;

    for (const entry of plan.entries) {
      if (entry.state === 'untracked') summary.untracked += 1;
      else if (entry.state === 'new') summary.newIssues += 1;
      else if (entry.state === 'persistent') summary.persistent += 1;
      else if (entry.state === 'resolved') summary.resolved += 1;
    }

    if (options.updateMemory) {
      if (loaded.toolingError && loaded.existed) {
        summary.toolingError = `${loaded.toolingError}; refusing to overwrite existing invalid regression memory`;
      } else {
        await store.save(options.findings, loaded.entries);
        summary.memoryUpdated = true;
      }
    }

    return { summary };
  }
}
