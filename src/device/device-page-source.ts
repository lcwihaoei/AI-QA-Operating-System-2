import { createHash } from 'node:crypto';
import type { DevicePlatform } from './device-provider.js';

export interface DeviceElementCandidate {
  id: string;
  platform: DevicePlatform;
  label: string;
  className: string;
  applicationId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

const MAX_SOURCE_CHARS = 5_000_000;
const MAX_TAGS = 5_000;
const MAX_CANDIDATES = 250;
const IOS_INTERACTIVE_TYPE = /(?:Button|Cell|Link|Switch|Segment|TabBar|Toolbar|MenuItem|Key)$/i;

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, raw: string) => {
      const code = Number(raw);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, raw: string) => {
      const code = Number.parseInt(raw, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_.:-]*)="([^"]*)"/g;
  for (const match of tag.matchAll(pattern)) result[match[1]!] = decodeXml(match[2] ?? '');
  return result;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function androidBounds(value: string | undefined): { x: number; y: number; width: number; height: number } | undefined {
  if (!value) return undefined;
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value);
  if (!match) return undefined;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return undefined;
  return { x: x1!, y: y1!, width: x2! - x1!, height: y2! - y1! };
}

function iosBounds(attrs: Record<string, string>): { x: number; y: number; width: number; height: number } | undefined {
  const x = Number(attrs.x);
  const y = Number(attrs.y);
  const width = Number(attrs.width);
  const height = Number(attrs.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function safeBounds(bounds: { x: number; y: number; width: number; height: number }): boolean {
  const { x, y, width, height } = bounds;
  return x >= -50 && y >= -50 && width >= 4 && height >= 4 && width <= 10_000 && height <= 10_000
    && x + width <= 20_000 && y + height <= 20_000;
}

function candidateId(platform: DevicePlatform, applicationId: string, label: string, className: string, x: number, y: number, width: number, height: number): string {
  return createHash('sha1')
    .update(`${platform}|${applicationId}|${className}|${label.toLowerCase().replace(/\s+/g, ' ').slice(0, 100)}|${x},${y},${width},${height}`)
    .digest('hex')
    .slice(0, 16);
}

export function parseDeviceElementCandidates(source: string, platform: DevicePlatform): DeviceElementCandidate[] {
  if (source.length > MAX_SOURCE_CHARS) throw new Error('device page source exceeds parser limit');
  const candidates: DeviceElementCandidate[] = [];
  const tagPattern = /<([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[^<>]*?)?\/?\s*>/g;
  let tags = 0;

  for (const match of source.matchAll(tagPattern)) {
    if (++tags > MAX_TAGS || candidates.length >= MAX_CANDIDATES) break;
    const tag = match[0];
    const tagName = match[1] ?? '';
    const attrs = attributes(tag);
    const enabled = bool(attrs.enabled, true);
    const visible = bool(attrs.visible ?? attrs.displayed, true);
    if (!enabled || !visible) continue;

    let interactive = false;
    let bounds: { x: number; y: number; width: number; height: number } | undefined;
    let label = '';
    let className = attrs.class ?? attrs.type ?? tagName;
    let applicationId = '';

    if (platform === 'android') {
      interactive = bool(attrs.clickable, false) || bool(attrs['long-clickable'], false);
      bounds = androidBounds(attrs.bounds);
      label = attrs['content-desc'] || attrs.text || attrs['resource-id'] || '';
      applicationId = attrs.package || '';
    } else {
      const type = attrs.type || tagName;
      interactive = IOS_INTERACTIVE_TYPE.test(type);
      bounds = iosBounds(attrs);
      label = attrs.label || attrs.name || attrs.value || '';
      className = type;
      applicationId = attrs.bundleId || attrs['bundle-id'] || '';
    }

    label = label.trim().replace(/\s+/g, ' ').slice(0, 160);
    applicationId = applicationId.trim().slice(0, 300);
    if (!interactive || !bounds || !safeBounds(bounds) || !label) continue;

    const centerX = Math.round(bounds.x + bounds.width / 2);
    const centerY = Math.round(bounds.y + bounds.height / 2);
    candidates.push({
      id: candidateId(platform, applicationId, label, className, bounds.x, bounds.y, bounds.width, bounds.height),
      platform,
      label,
      className,
      applicationId: applicationId || undefined,
      ...bounds,
      centerX,
      centerY,
    });
  }

  return candidates;
}
