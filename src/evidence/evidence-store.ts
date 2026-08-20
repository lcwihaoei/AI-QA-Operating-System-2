import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { QaEvent, QaRunResult } from '../core/types.js';

export class EvidenceStore {
  readonly runDir: string;
  private sequence = 0;

  constructor(baseDir: string, runId: string) {
    this.runDir = path.resolve(baseDir, runId);
  }

  async init(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await mkdir(path.join(this.runDir, 'screenshots'), { recursive: true });
    await mkdir(path.join(this.runDir, 'videos'), { recursive: true });
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

  async writeResult(result: QaRunResult): Promise<void> {
    await writeFile(path.join(this.runDir, 'result.json'), JSON.stringify(result, null, 2));
  }

  private nextScreenshotPath(label: string): string {
    const safe = label.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'screen';
    return path.join(this.runDir, 'screenshots', `${String(++this.sequence).padStart(4, '0')}-${safe}.png`);
  }
}
