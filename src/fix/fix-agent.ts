import type { Finding } from '../core/types.js';
import { fixBranchName, validateFixProposal } from './fix-policy.js';
import type { FixAgentResult, FixMode, FixModel, FixWorkspace } from './fix-types.js';

export interface FixAgentOptions {
  finding: Finding;
  mode: FixMode;
  maxContextFiles?: number;
}

export class FixAgent {
  constructor(private readonly model: FixModel, private readonly workspace: FixWorkspace) {}

  async run(options: FixAgentOptions): Promise<FixAgentResult> {
    const result: FixAgentResult = {
      mode: options.mode,
      planned: false,
      executed: false,
      targetedPassed: false,
      reproductionPassed: false,
      regressionPassed: false,
      verified: false,
      rolledBack: false,
    };

    try {
      const files = await this.workspace.collectContext(options.finding, options.maxContextFiles ?? 6);
      if (files.length === 0) throw new Error('no safe source context matched the finding');
      const proposal = await this.model.propose({
        finding: {
          fingerprint: options.finding.fingerprint,
          severity: options.finding.severity,
          kind: options.finding.kind,
          title: options.finding.title,
          message: options.finding.message,
          reproduction: options.finding.reproduction.slice(0, 12),
        },
        files,
      });
      const errors = validateFixProposal(proposal, options.finding.fingerprint);
      if (errors.length > 0) throw new Error(`fix proposal rejected: ${errors.join('; ')}`);
      result.proposal = proposal;
      result.planned = true;
      if (options.mode === 'plan') return result;

      const originalBranch = await this.workspace.currentBranch();
      if (['main', 'master', 'trunk'].includes(originalBranch.toLowerCase())) {
        throw new Error('execute mode refuses to start from a default branch; use a disposable feature branch checkout');
      }
      if (!(await this.workspace.isClean())) throw new Error('execute mode requires a clean working tree');

      const branch = fixBranchName(options.finding.fingerprint);
      result.branch = branch;
      await this.workspace.createBranch(branch);
      try {
        for (const replacement of proposal.replacements) await this.workspace.replaceFile(replacement);
        result.executed = true;

        for (const command of proposal.targetedTests) {
          const tested = await this.workspace.run(command);
          if (tested.exitCode !== 0) throw new Error(`targeted test failed: ${command.program} ${command.args.join(' ')}`);
        }
        result.targetedPassed = true;

        const reproduction = await this.workspace.run(proposal.reproduction);
        if (reproduction.exitCode !== 0) throw new Error('original reproduction gate failed after fix');
        result.reproductionPassed = true;

        const regression = await this.workspace.run(proposal.regression);
        if (regression.exitCode !== 0) throw new Error('full regression gate failed after fix');
        result.regressionPassed = true;
        result.verified = true;
        return result;
      } catch (error: unknown) {
        await this.workspace.rollback(originalBranch, branch);
        result.rolledBack = true;
        throw error;
      }
    } catch (error: unknown) {
      result.error = String(error);
      return result;
    }
  }
}
