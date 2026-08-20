import path from 'node:path';
import type { FixCommand, FixProposal } from './fix-types.js';

const MAX_FILES = 8;
const MAX_FILE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 500_000;
const MAX_COMMAND_ARGS = 40;
const MAX_ARG_CHARS = 500;
const DENIED_PATH = /(^|\/)(\.git|\.github\/workflows|\.env(?:\.|$)|secrets?|credentials?|private[-_]?keys?|id_rsa|id_ed25519)(\/|$)/i;
const DENIED_FILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const ALLOWED_PROGRAMS = new Set(['npm', 'npx', 'node', 'python', 'python3', 'pytest', 'go', 'flutter', 'dart', 'cargo']);
const SHELL_META = /[;&|><`$\n\r]/;

export function safeFixPath(value: string): boolean {
  if (!value || value.length > 500 || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || value.split('/').includes('..')) return false;
  if (DENIED_PATH.test(value) || DENIED_FILE.test(value)) return false;
  return /^[A-Za-z0-9._/@+ -]+(?:\/[A-Za-z0-9._/@+ -]+)*$/.test(value);
}

export function validateFixCommand(command: FixCommand): string | undefined {
  if (!ALLOWED_PROGRAMS.has(command.program)) return `program ${command.program} is not allowed`;
  if (!Array.isArray(command.args) || command.args.length > MAX_COMMAND_ARGS) return 'too many command arguments';
  for (const arg of command.args) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_CHARS || SHELL_META.test(arg)) return 'unsafe command argument';
  }
  if (command.program === 'git') return 'git commands are workspace-owned, not model-owned';
  return undefined;
}

export function validateFixProposal(proposal: FixProposal, fingerprint: string): string[] {
  const errors: string[] = [];
  if (proposal.findingFingerprint !== fingerprint) errors.push('proposal fingerprint does not match finding');
  if (!proposal.summary || proposal.summary.length > 2_000) errors.push('proposal summary is missing or oversized');
  if (!Array.isArray(proposal.replacements) || proposal.replacements.length < 1 || proposal.replacements.length > MAX_FILES) {
    errors.push(`proposal must replace 1-${MAX_FILES} files`);
  }
  let total = 0;
  const paths = new Set<string>();
  for (const replacement of proposal.replacements ?? []) {
    if (!safeFixPath(replacement.path)) errors.push(`unsafe replacement path: ${replacement.path}`);
    if (paths.has(replacement.path)) errors.push(`duplicate replacement path: ${replacement.path}`);
    paths.add(replacement.path);
    if (!/^[a-f0-9]{64}$/i.test(replacement.expectedSha256)) errors.push(`invalid expected sha256 for ${replacement.path}`);
    if (replacement.content.length > MAX_FILE_CHARS) errors.push(`replacement exceeds ${MAX_FILE_CHARS} characters: ${replacement.path}`);
    total += replacement.content.length;
  }
  if (total > MAX_TOTAL_CHARS) errors.push('replacement payload is too large');
  if (!Array.isArray(proposal.targetedTests) || proposal.targetedTests.length < 1 || proposal.targetedTests.length > 8) {
    errors.push('proposal must include 1-8 targeted tests');
  }
  for (const command of [...(proposal.targetedTests ?? []), proposal.reproduction, proposal.regression]) {
    if (!command) {
      errors.push('proposal is missing reproduction or regression command');
      continue;
    }
    const error = validateFixCommand(command);
    if (error) errors.push(error);
  }
  return errors;
}

export function fixBranchName(fingerprint: string): string {
  const normalized = fingerprint.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  if (!normalized) throw new Error('finding fingerprint cannot produce a safe fix branch');
  return `aiqa/fix/${normalized}`;
}
