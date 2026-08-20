import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { buildArchitectureInterview, validateArchitectureAnswers, type ArchitectureAnswer, type ArchitectureInterview } from './backend/architecture-interview.js';
import { discoverFrontend } from './backend/frontend-discovery.js';

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

const program = new Command();
program.name('aiqa-backend').description('Beta.8 frontend discovery and backend architecture interview tools');

program.command('discover')
  .requiredOption('--repo <path>', 'frontend repository/project root')
  .option('--out <path>', 'output directory', '.qa-backend')
  .option('--max-files <count>', 'maximum files to scan', (value) => Number.parseInt(value, 10), 8000)
  .option('--max-file-bytes <count>', 'maximum bytes per source file', (value) => Number.parseInt(value, 10), 1500000)
  .action(async (options: { repo: string; out: string; maxFiles: number; maxFileBytes: number }) => {
    const discovery = await discoverFrontend(options.repo, { maxFiles: options.maxFiles, maxFileBytes: options.maxFileBytes });
    const interview = buildArchitectureInterview(discovery);
    const outDir = path.resolve(options.out);
    await writeJson(path.join(outDir, 'frontend-discovery.json'), discovery);
    await writeJson(path.join(outDir, 'architecture-interview.json'), interview);
    process.stdout.write(`Frontend discovery complete: ${discovery.filesScanned} file(s), ${discovery.routes.length} route(s), ${discovery.mockSources.length} mock source(s).\n`);
    process.stdout.write(`Review ${path.join(outDir, 'frontend-discovery.json')} and ${path.join(outDir, 'architecture-interview.json')} before any backend generation.\n`);
  });

program.command('validate-interview')
  .requiredOption('--interview <path>', 'architecture-interview.json path')
  .requiredOption('--answers <path>', 'JSON array of architecture answers')
  .action(async (options: { interview: string; answers: string }) => {
    const interview = JSON.parse(await readFile(options.interview, 'utf8')) as ArchitectureInterview;
    const answers = JSON.parse(await readFile(options.answers, 'utf8')) as ArchitectureAnswer[];
    if (!Array.isArray(answers)) throw new Error('answers file must contain a JSON array');
    const validation = validateArchitectureAnswers(interview, answers);
    process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
    if (!validation.readyForBlueprint) process.exitCode = 2;
  });

await program.parseAsync(process.argv);
