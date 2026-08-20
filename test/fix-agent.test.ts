import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FixAgent } from '../src/fix/fix-agent.js';
import { validateFixProposal } from '../src/fix/fix-policy.js';
import type { Finding } from '../src/core/types.js';
import type { FixModel, FixWorkspace } from '../src/fix/fix-types.js';

const finding: Finding = {
  id: 'BUG-1', kind: 'assertion', severity: 'high', title: 'Save button fails', url: 'https://example.test/settings',
  message: 'Save returns 500', reproduction: ['Open settings', 'Click Save'], evidence: [], fingerprint: 'abc123',
};
const content = 'export const value = 1;\n';
const hash = createHash('sha256').update(content).digest('hex');
const proposal = {
  findingFingerprint: 'abc123', summary: 'Handle failed save',
  replacements: [{ path: 'src/save.ts', expectedSha256: hash, content: 'export const value = 2;\n' }],
  targetedTests: [{ program: 'npm', args: ['test', '--', 'save'] }],
  reproduction: { program: 'npm', args: ['test', '--', 'save-repro'] },
  regression: { program: 'npm', args: ['run', 'check'] },
};

function workspace(exitCodes = [0, 0, 0]): FixWorkspace {
  let index = 0;
  return {
    currentBranch: vi.fn().mockResolvedValue('agent/work'),
    isClean: vi.fn().mockResolvedValue(true),
    collectContext: vi.fn().mockResolvedValue([{ path: 'src/save.ts', sha256: hash, content }]),
    createBranch: vi.fn().mockResolvedValue(undefined),
    replaceFile: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockImplementation(async () => ({ exitCode: exitCodes[index++] ?? 0, stdout: '', stderr: '' })),
    rollback: vi.fn().mockResolvedValue(undefined),
  };
}

function model(value = proposal): FixModel {
  return { propose: vi.fn().mockResolvedValue(value) };
}

describe('FixAgent', () => {
  it('plans without mutating the workspace', async () => {
    const ws = workspace();
    const result = await new FixAgent(model(), ws).run({ finding, mode: 'plan' });
    expect(result).toMatchObject({ planned: true, executed: false, verified: false });
    expect(ws.createBranch).not.toHaveBeenCalled();
    expect(ws.replaceFile).not.toHaveBeenCalled();
  });

  it('executes only on an isolated branch and requires all three verification gates', async () => {
    const ws = workspace();
    const result = await new FixAgent(model(), ws).run({ finding, mode: 'execute' });
    expect(result).toMatchObject({
      planned: true, executed: true, targetedPassed: true, reproductionPassed: true, regressionPassed: true, verified: true, rolledBack: false,
    });
    expect(ws.createBranch).toHaveBeenCalledWith('aiqa/fix/abc123');
    expect(ws.replaceFile).toHaveBeenCalledTimes(1);
    expect(ws.run).toHaveBeenCalledTimes(3);
  });

  it('rolls back when regression fails', async () => {
    const ws = workspace([0, 0, 1]);
    const result = await new FixAgent(model(), ws).run({ finding, mode: 'execute' });
    expect(result.verified).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(ws.rollback).toHaveBeenCalledWith('agent/work', 'aiqa/fix/abc123');
  });

  it('rejects workflow/secrets paths and shell-like command arguments', () => {
    expect(validateFixProposal({ ...proposal, replacements: [{ ...proposal.replacements[0], path: '.github/workflows/ci.yml' }] }, 'abc123')).not.toHaveLength(0);
    expect(validateFixProposal({ ...proposal, targetedTests: [{ program: 'npm', args: ['test; rm -rf /'] }] }, 'abc123')).not.toHaveLength(0);
  });

  it('refuses execute mode from a default branch', async () => {
    const ws = workspace();
    vi.mocked(ws.currentBranch).mockResolvedValue('main');
    const result = await new FixAgent(model(), ws).run({ finding, mode: 'execute' });
    expect(result.executed).toBe(false);
    expect(result.error).toContain('default branch');
  });
});
