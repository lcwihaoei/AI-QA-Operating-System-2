import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Page } from '@playwright/test';
import type { QaEvent, QaRunResult } from '../core/types.js';

export interface HarCompactionResult {
  source: string;
  target?: string;
  originalBytes: number;
  compacted: boolean;
}

export class EvidenceStore {
  readonly runDir: string;
  private sequence = 0;

  constructor(baseDir: string, runId: string) {
    this.runDir = path.resolve(baseDir, runId);
  }

  async init(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await mkdir(path.join(this.runDir, 'screenshots'), { recursive: true });
  }

  async screenshot(page: Page, label: string): Promise<string> {
    const file = this.nextScreenshotPath(label);
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    return file;
  }

  async writePngBase64(base64: string, label: string): Promise<string> {
    const normalized = base64.replace(/\s+/g, '');
    if (!normalized || !/^[A-Za-z0-9+/=]+$/.test(normalized)) throw new Error('invalid base64 PNG evidence payload');
    const buffer = Buffer.from(normalized, 'base64');
    if (buffer.length === 0 || buffer.length > 18_000_000) throw new Error('device screenshot must be between 1 byte and 18 MB');
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length < pngSignature.length || !buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error('device screenshot payload is not a PNG');
    }
    const file = this.nextScreenshotPath(label);
    await writeFile(file, buffer);
    return file;
  }

  async writeEvents(events: QaEvent[]): Promise<void> {
    await writeFile(path.join(this.runDir, 'events.json'), JSON.stringify(events, null, 2));
  }

  async compactHar(thresholdBytes = 5_000_000): Promise<HarCompactionResult | undefined> {
    const source = path.join(this.runDir, 'network.har');
    let metadata;
    try {
      metadata = await stat(source);
    } catch {
      return undefined;
    }

    if (metadata.size < Math.max(0, thresholdBytes)) {
      return { source, originalBytes: metadata.size, compacted: false };
    }

    const target = `${source}.gz`;
    await pipeline(
      createReadStream(source),
      createGzip({ level: 6 }),
      createWriteStream(target, { flags: 'w' }),
    );
    await unlink(source);
    return { source, target, originalBytes: metadata.size, compacted: true };
  }

  async writeResult(result: QaRunResult): Promise<void> {
    // HAR is highly repetitive JSON. Beta.5 field validation produced nearly
    // gigabyte-scale files on large Vite apps even in Playwright minimal mode.
    // Compress oversized completed HARs after the browser context closes; if
    // compaction fails, keep the original artifact and never block result.json.
    await this.compactHar().catch(() => undefined);
    await writeFile(path.join(this.runDir, 'result.json'), JSON.stringify(result, null, 2));
  }

  private nextScreenshotPath(label: string): string {
    const safe = label.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'screen';
    return path.join(this.runDir, 'screenshots', `${String(++this.sequence).padStart(4, '0')}-${safe}.png`);
  }
}
