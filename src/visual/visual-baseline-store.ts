import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { QaEvent, VisualBaselineSummary } from '../core/types.js';

export type VisualBaselineState = 'new' | 'persistent' | 'untracked';

export interface VisualBaselineEntry {
  key: string;
  route: string;
  viewport: string;
  visualKind: string;
  element?: string;
  relatedElement?: string;
  message: string;
}

interface VisualBaselineFile {
  version: 3;
  analyzerVersion: 'dom-geometry-v3';
  updatedAt: string;
  analyzedStates: number;
  entries: VisualBaselineEntry[];
}

export interface VisualBaselineComparison {
  events: QaEvent[];
  current: VisualBaselineEntry[];
  resolved: VisualBaselineEntry[];
  summary: VisualBaselineSummary;
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const HEX_ID_LIKE = /^[0-9a-f]{16,}$/i;
const ANALYZER_VERSION = 'dom-geometry-v3' as const;

function normalizeDynamicText(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function normalizeVisualRoute(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').map((part) => {
      if (!part) return part;
      if (/^\d+$/.test(part) || UUID_LIKE.test(part) || HEX_ID_LIKE.test(part)) return ':id';
      return part;
    });
    return parts.join('/') || '/';
  } catch {
    return value.split('?')[0] || '/';
  }
}

export function visualBaselineEntryFromEvent(event: QaEvent): VisualBaselineEntry | undefined {
  if (event.kind !== 'ui' || event.details?.visual !== true) return undefined;
  const viewport = typeof event.details.viewport === 'string' ? event.details.viewport : undefined;
  const visualKind = typeof event.details.visualKind === 'string' ? event.details.visualKind : undefined;
  if (!viewport || !visualKind) return undefined;

  const route = normalizeVisualRoute(event.url);
  const element = typeof event.details.element === 'string' ? normalizeDynamicText(event.details.element) : undefined;
  const relatedElement = typeof event.details.relatedElement === 'string'
    ? normalizeDynamicText(event.details.relatedElement)
    : undefined;
  const pair = visualKind === 'interactive-overlap'
    ? [element ?? '', relatedElement ?? ''].sort()
    : [element ?? '', relatedElement ?? ''];
  const normalizedMessage = normalizeDynamicText(event.message.replace(/\s*\[viewport=.*?\]\s*$/, ''));
  const source = [route, viewport, visualKind, pair[0], pair[1], normalizedMessage].join('|');
  const key = createHash('sha1').update(source).digest('hex').slice(0, 20);

  return {
    key,
    route,
    viewport,
    visualKind,
    element,
    relatedElement,
    message: normalizedMessage,
  };
}

export class VisualBaselineStore {
  constructor(private readonly filePath: string) {}

  async compare(events: QaEvent[]): Promise<VisualBaselineComparison> {
    const current = this.extract(events);
    const loaded = await this.load();
    const baseline = new Map(loaded.entries.map((entry) => [entry.key, entry]));
    const currentByKey = new Map(current.map((entry) => [entry.key, entry]));
    const resolved = loaded.existed
      ? [...baseline.values()].filter((entry) => !currentByKey.has(entry.key))
      : [];

    let newSignals = 0;
    let persistentSignals = 0;
    const annotated = events.map((event) => {
      const entry = visualBaselineEntryFromEvent(event);
      if (!entry) return event;

      let baselineState: VisualBaselineState = 'untracked';
      if (loaded.existed) {
        baselineState = baseline.has(entry.key) ? 'persistent' : 'new';
        if (baselineState === 'persistent') persistentSignals += 1;
        else newSignals += 1;
      }

      return {
        ...event,
        details: {
          ...event.details,
          baselineKey: entry.key,
          baselineState,
        },
      };
    });

    const summary: VisualBaselineSummary = {
      enabled: true,
      path: this.filePath,
      existed: loaded.existed,
      newSignals,
      persistentSignals,
      resolvedSignals: resolved.length,
      updated: false,
      error: loaded.error,
    };

    const telemetryUrl = annotated.find((event) => event.details?.visual === true)?.url ?? 'about:blank';
    annotated.push({
      timestamp: new Date().toISOString(),
      kind: 'snapshot',
      url: telemetryUrl,
      message: 'Visual regression baseline comparison',
      details: {
        visualBaseline: true,
        ...summary,
        baselineSchemaVersion: 3,
        baselineAnalyzerVersion: loaded.analyzerVersion,
        baselineAnalyzedStates: loaded.analyzedStates,
        resolved: resolved.slice(0, 50),
      },
    });

    return { events: annotated, current, resolved, summary };
  }

  async save(entries: VisualBaselineEntry[], analyzedStates: number): Promise<void> {
    if (!Number.isInteger(analyzedStates) || analyzedStates <= 0) {
      throw new Error('visual baseline requires at least one successfully analyzed visual state');
    }
    const unique = [...new Map(entries.map((entry) => [entry.key, entry])).values()]
      .sort((a, b) => a.key.localeCompare(b.key));
    const manifest: VisualBaselineFile = {
      version: 3,
      analyzerVersion: ANALYZER_VERSION,
      updatedAt: new Date().toISOString(),
      analyzedStates,
      entries: unique,
    };
    await mkdir(path.dirname(path.resolve(this.filePath)), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(manifest, null, 2));
  }

  private extract(events: QaEvent[]): VisualBaselineEntry[] {
    const entries = events
      .map(visualBaselineEntryFromEvent)
      .filter((entry): entry is VisualBaselineEntry => Boolean(entry));
    return [...new Map(entries.map((entry) => [entry.key, entry])).values()];
  }

  private async load(): Promise<{ existed: boolean; entries: VisualBaselineEntry[]; analyzedStates?: number; analyzerVersion?: string; error?: string }> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as {
        version?: number;
        analyzerVersion?: string;
        analyzedStates?: number;
        entries?: unknown[];
      };
      if (raw.version !== 3 || raw.analyzerVersion !== ANALYZER_VERSION || !Array.isArray(raw.entries)) {
        const legacy = raw.version === 1
          ? 'legacy beta.4 baseline must be regenerated after visual-classifier changes'
          : raw.version === 2
            ? 'beta.5 visual baseline must be explicitly regenerated after beta.6 visual-classifier changes'
            : 'visual baseline has unsupported or invalid format';
        return { existed: false, entries: [], error: legacy };
      }
      const entries = raw.entries.filter((entry): entry is VisualBaselineEntry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const source = entry as Record<string, unknown>;
        return typeof source.key === 'string'
          && typeof source.route === 'string'
          && typeof source.viewport === 'string'
          && typeof source.visualKind === 'string'
          && typeof source.message === 'string';
      });
      const analyzedStates = typeof raw.analyzedStates === 'number' && Number.isInteger(raw.analyzedStates) && raw.analyzedStates > 0
        ? raw.analyzedStates
        : undefined;
      if (!analyzedStates) {
        return { existed: false, entries: [], error: 'visual baseline is missing analyzed-state provenance' };
      }
      return { existed: true, entries, analyzedStates, analyzerVersion: raw.analyzerVersion };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false, entries: [] };
      return { existed: false, entries: [], error: String(error) };
    }
  }
}
