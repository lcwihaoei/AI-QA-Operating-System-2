#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { z } from 'zod';
import { evaluateUxExperiment } from './ux/ux-experiment.js';
import { UxLearningStore } from './ux/ux-learning-store.js';

const measurement = z.object({
  id: z.string().min(1).max(100), sampleSize: z.number().int().min(1).max(1_000_000), uxScore: z.number().min(0).max(100),
  completionRate: z.number().min(0).max(1), medianActions: z.number().min(0).max(10_000), backtracksPerTask: z.number().min(0).max(10_000), errorRate: z.number().min(0).max(1),
});
const inputSchema = z.object({ control: measurement, variants: z.array(measurement).min(1).max(50) });
const program = new Command();
program
  .name('aiqa-ux-experiment')
  .requiredOption('--input <json>', 'experiment measurements JSON')
  .option('--product <key>', 'product key for optional learning memory')
  .option('--memory <file>', 'UX learning memory', '.qa-memory/ux-learning.json')
  .option('--accept-learning', 'explicitly record the experiment result in learning memory', false);
program.parse();
const raw = program.opts();
const input = inputSchema.parse(JSON.parse(await readFile(raw.input, 'utf8')));
const result = evaluateUxExperiment(input.control, input.variants);
if (raw.acceptLearning) {
  if (!raw.product) throw new Error('--accept-learning requires --product');
  await new UxLearningStore(raw.memory).recordExperiment(raw.product, result);
}
console.log(JSON.stringify(result, null, 2));
