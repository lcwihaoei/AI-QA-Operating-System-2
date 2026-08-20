import type { Finding } from '../core/types.js';

export type FixMode = 'plan' | 'execute';

export interface FixCommand {
  program: string;
  args: string[];
}

export interface FixSourceFile {
  path: string;
  sha256: string;
  content: string;
}

export interface FixFileReplacement {
  path: string;
  expectedSha256: string;
  content: string;
}

export interface FixProposal {
  findingFingerprint: string;
  summary: string;
  replacements: FixFileReplacement[];
  targetedTests: FixCommand[];
  reproduction: FixCommand;
  regression: FixCommand;
}

export interface FixModelContext {
  finding: Pick<Finding, 'fingerprint' | 'severity' | 'kind' | 'title' | 'message' | 'reproduction'>;
  files: FixSourceFile[];
}

export interface FixModel {
  propose(context: FixModelContext): Promise<FixProposal>;
}

export interface FixCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FixWorkspace {
  currentBranch(): Promise<string>;
  isClean(): Promise<boolean>;
  collectContext(finding: Finding, maxFiles: number): Promise<FixSourceFile[]>;
  createBranch(branch: string): Promise<void>;
  replaceFile(replacement: FixFileReplacement): Promise<void>;
  run(command: FixCommand): Promise<FixCommandResult>;
  rollback(originalBranch: string, fixBranch: string): Promise<void>;
}

export interface FixAgentResult {
  mode: FixMode;
  branch?: string;
  proposal?: FixProposal;
  planned: boolean;
  executed: boolean;
  targetedPassed: boolean;
  reproductionPassed: boolean;
  regressionPassed: boolean;
  verified: boolean;
  rolledBack: boolean;
  error?: string;
}
