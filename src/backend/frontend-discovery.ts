import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type DiscoveryConfidence = 'high' | 'medium' | 'low';

export interface DiscoveryEvidence {
  path: string;
  line?: number;
  confidence: DiscoveryConfidence;
  detail: string;
}

export interface FrameworkFinding {
  name: string;
  confidence: DiscoveryConfidence;
  evidence: DiscoveryEvidence[];
}

export interface RouteFinding {
  route: string;
  source: string;
  confidence: DiscoveryConfidence;
  evidence: DiscoveryEvidence;
}

export interface FormFinding {
  id: string;
  source: string;
  method?: string;
  action?: string;
  fields: string[];
  confidence: DiscoveryConfidence;
  evidence: DiscoveryEvidence;
}

export interface ApiCandidate {
  method: string;
  endpoint: string;
  source: string;
  confidence: DiscoveryConfidence;
  evidence: DiscoveryEvidence;
}

export interface MockSourceFinding {
  source: string;
  kind: 'mock-file' | 'fixture' | 'stub' | 'inline-mock' | 'local-json' | 'mock-library';
  confidence: DiscoveryConfidence;
  evidence: DiscoveryEvidence;
}

export interface StateFinding {
  key: string;
  source: string;
  mechanism: string;
  confidence: DiscoveryConfidence;
  evidence: DiscoveryEvidence;
}

export interface EntityCandidate {
  name: string;
  confidence: DiscoveryConfidence;
  sources: string[];
}

export interface FrontendDiscoveryResult {
  schemaVersion: 1;
  generatedAt: string;
  projectName: string;
  filesScanned: number;
  bytesScanned: number;
  skipped: {
    ignoredDirectories: number;
    sensitiveFiles: number;
    oversizedFiles: number;
    unsupportedFiles: number;
    fileLimitReached: boolean;
  };
  languages: Record<string, number>;
  frameworks: FrameworkFinding[];
  routes: RouteFinding[];
  forms: FormFinding[];
  apiCandidates: ApiCandidate[];
  mockSources: MockSourceFinding[];
  state: StateFinding[];
  entities: EntityCandidate[];
  unresolvedQuestions: string[];
}

export interface FrontendDiscoveryOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  includeExtensions?: string[];
}

interface SourceFile {
  relativePath: string;
  content: string;
  language: string;
  size: number;
}

const DEFAULT_MAX_FILES = 8_000;
const DEFAULT_MAX_FILE_BYTES = 1_500_000;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.nyc_output', '.dart_tool', '.idea', '.vscode', 'Pods', 'DerivedData', '.gradle', 'target', 'bin', 'obj',
]);
const SENSITIVE_BASENAMES = [
  /^\.env(?:\..+)?$/i,
  /^(?:id_rsa|id_ed25519)(?:\.pub)?$/i,
  /(?:secret|credential|private[-_]?key|service[-_]?account)/i,
  /\.(?:pem|p12|pfx|key|keystore|jks)$/i,
];
const EXTENSION_LANGUAGE: Array<[RegExp, string]> = [
  [/\.tsx$/i, 'TypeScript/TSX'], [/\.ts$/i, 'TypeScript'], [/\.jsx$/i, 'JavaScript/JSX'], [/\.(?:js|mjs|cjs)$/i, 'JavaScript'],
  [/\.vue$/i, 'Vue SFC'], [/\.svelte$/i, 'Svelte'], [/\.astro$/i, 'Astro'], [/\.(?:html?|xhtml)$/i, 'HTML'],
  [/\.(?:css|scss|sass|less|styl)$/i, 'Stylesheet'], [/\.dart$/i, 'Dart/Flutter'], [/\.blade\.php$/i, 'Laravel Blade'],
  [/\.php$/i, 'PHP'], [/\.twig$/i, 'Twig'], [/\.(?:cshtml|razor)$/i, 'Razor'], [/\.xaml$/i, 'XAML'],
  [/\.(?:kt|kts)$/i, 'Kotlin'], [/\.swift$/i, 'Swift'], [/\.(?:java)$/i, 'Java'], [/\.json$/i, 'JSON'], [/\.ya?ml$/i, 'YAML'],
];
const DEFAULT_SUPPORTED_PATTERNS = EXTENSION_LANGUAGE.map(([pattern]) => pattern);

function normalizeRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function languageFor(filePath: string): string | undefined {
  return EXTENSION_LANGUAGE.find(([pattern]) => pattern.test(filePath))?.[1];
}

function isSensitive(relativePath: string): boolean {
  const basename = path.basename(relativePath);
  return SENSITIVE_BASENAMES.some((pattern) => pattern.test(basename) || pattern.test(relativePath));
}

function lineFor(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split('\n').length;
}

function bounded(value: string, max = 240): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function routeSafe(value: string): string | undefined {
  const route = bounded(value, 300);
  if (!route || /^(?:https?:|mailto:|tel:|javascript:|#)/i.test(route)) return undefined;
  if (!route.startsWith('/')) return undefined;
  if (route.includes('${') || route.includes('{') && !route.includes(':')) return route.replace(/\[[^\]]+\]/g, ':param');
  return route;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function singularize(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]/g, ' ').trim();
  const token = clean.split(/[-_\s]+/).filter(Boolean).pop() ?? '';
  if (!token) return '';
  if (/ies$/i.test(token)) return `${token.slice(0, -3)}y`;
  if (/ses$/i.test(token)) return token.slice(0, -2);
  if (/s$/i.test(token) && !/ss$/i.test(token)) return token.slice(0, -1);
  return token;
}

function sourceEvidence(file: SourceFile, index: number, confidence: DiscoveryConfidence, detail: string): DiscoveryEvidence {
  return { path: file.relativePath, line: lineFor(file.content, index), confidence, detail: bounded(detail) };
}

async function collectFiles(rootDir: string, options: Required<Pick<FrontendDiscoveryOptions, 'maxFiles' | 'maxFileBytes'>> & { includeExtensions?: string[] }) {
  const files: SourceFile[] = [];
  const skipped = { ignoredDirectories: 0, sensitiveFiles: 0, oversizedFiles: 0, unsupportedFiles: 0, fileLimitReached: false };
  const explicitExtensions = options.includeExtensions?.map((value) => value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`);

  async function walk(directory: string): Promise<void> {
    if (files.length >= options.maxFiles) { skipped.fileLimitReached = true; return; }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= options.maxFiles) { skipped.fileLimitReached = true; return; }
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelative(rootDir, absolute);
      if (entry.isSymbolicLink()) { skipped.ignoredDirectories += entry.isDirectory() ? 1 : 0; continue; }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) { skipped.ignoredDirectories += 1; continue; }
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSensitive(relative)) { skipped.sensitiveFiles += 1; continue; }
      const language = languageFor(relative);
      const supported = explicitExtensions
        ? explicitExtensions.some((extension) => relative.toLowerCase().endsWith(extension))
        : DEFAULT_SUPPORTED_PATTERNS.some((pattern) => pattern.test(relative));
      if (!supported || !language) { skipped.unsupportedFiles += 1; continue; }
      const info = await stat(absolute);
      if (info.size > options.maxFileBytes) { skipped.oversizedFiles += 1; continue; }
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) { skipped.unsupportedFiles += 1; continue; }
      files.push({ relativePath: relative, content: buffer.toString('utf8'), language, size: info.size });
    }
  }

  await walk(rootDir);
  return { files, skipped };
}

function detectFrameworks(files: SourceFile[]): FrameworkFinding[] {
  const evidence = new Map<string, DiscoveryEvidence[]>();
  const add = (name: string, file: SourceFile, index: number, confidence: DiscoveryConfidence, detail: string) => {
    const list = evidence.get(name) ?? [];
    if (list.length < 8) list.push(sourceEvidence(file, index, confidence, detail));
    evidence.set(name, list);
  };

  for (const file of files) {
    const text = file.content;
    const checks: Array<[string, RegExp, DiscoveryConfidence, string]> = [
      ['React', /(?:from\s+['"]react['"]|"react"\s*:)/i, 'high', 'React import or dependency'],
      ['Next.js', /(?:from\s+['"]next\/|"next"\s*:)/i, 'high', 'Next.js import or dependency'],
      ['Vue', /(?:from\s+['"]vue['"]|"vue"\s*:|<template[\s>])/i, 'high', 'Vue import, dependency, or SFC template'],
      ['Nuxt', /(?:from\s+['"]#app['"]|"nuxt"\s*:|defineNuxtConfig)/i, 'high', 'Nuxt marker'],
      ['Angular', /(?:@angular\/core|"@angular\/core"\s*:|@Component\s*\()/i, 'high', 'Angular marker'],
      ['Svelte', /(?:"svelte"\s*:|from\s+['"]svelte['"]|<svelte:)/i, 'high', 'Svelte marker'],
      ['Astro', /(?:"astro"\s*:|from\s+['"]astro[:/])/i, 'high', 'Astro marker'],
      ['Flutter', /(?:package:flutter\/|MaterialApp\s*\(|CupertinoApp\s*\()/i, 'high', 'Flutter marker'],
      ['Laravel Blade', /(?:@extends\s*\(|@section\s*\(|@csrf\b|\.blade\.php)/i, 'medium', 'Blade template marker'],
      ['Razor', /(?:@page\b|@model\b|asp-controller=|asp-action=)/i, 'medium', 'Razor marker'],
      ['HTMX', /\bhx-(?:get|post|put|patch|delete|target|swap)=/i, 'high', 'HTMX attribute'],
      ['Alpine.js', /\bx-(?:data|show|model|on:|bind:)/i, 'medium', 'Alpine directive'],
    ];
    for (const [name, pattern, confidence, detail] of checks) {
      const match = pattern.exec(text);
      if (match) add(name, file, match.index, confidence, detail);
    }
  }

  return [...evidence.entries()]
    .map(([name, entries]) => ({ name, confidence: entries.some((item) => item.confidence === 'high') ? 'high' as const : 'medium' as const, evidence: entries }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function detectRoutes(files: SourceFile[]): RouteFinding[] {
  const results: RouteFinding[] = [];
  const patterns: Array<[RegExp, DiscoveryConfidence, string]> = [
    [/<Route\b[^>]*\bpath\s*=\s*["']([^"']+)["']/gi, 'high', 'JSX route'],
    [/\bpath\s*:\s*["']([^"']+)["']/gi, 'high', 'router path'],
    [/\b(?:router\.(?:get|post|put|patch|delete)|navigate|router\.push|router\.replace)\s*\(\s*["']([^"']+)["']/gi, 'medium', 'navigation call'],
    [/\bhref\s*=\s*["']([^"']+)["']/gi, 'medium', 'local link'],
    [/\b(?:initialRoute|initialRouteName)\s*[:=]\s*["']([^"']+)["']/gi, 'medium', 'initial route'],
    [/\b(?:routes|namedRoutes)\s*[:=]\s*\{[\s\S]{0,1600}?(["']\/[^"']+["'])/gi, 'low', 'route-map candidate'],
  ];

  for (const file of files) {
    for (const [pattern, confidence, detail] of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      for (const match of file.content.matchAll(regex)) {
        const candidate = routeSafe((match[1] ?? '').replace(/^['"]|['"]$/g, ''));
        if (!candidate) continue;
        results.push({ route: candidate, source: file.relativePath, confidence, evidence: sourceEvidence(file, match.index ?? 0, confidence, detail) });
      }
    }

    const nextLike = /(?:^|\/)(?:pages|app)\/(.+?)\.(?:tsx?|jsx?|vue|svelte)$/i.exec(file.relativePath);
    if (nextLike) {
      let route = `/${nextLike[1]}`.replace(/\/(?:index|page)$/i, '').replace(/\/(?:layout|loading|error|not-found)$/i, '');
      route = route.replace(/\[\.\.\.[^\]]+\]/g, ':path*').replace(/\[[^\]]+\]/g, ':param').replace(/\([^/]+\)\//g, '');
      route = route === '' ? '/' : route;
      results.push({ route, source: file.relativePath, confidence: 'medium', evidence: { path: file.relativePath, confidence: 'medium', detail: 'file-system route candidate' } });
    }
  }

  return dedupeBy(results, (item) => `${item.route}\u0000${item.source}`).sort((a, b) => a.route.localeCompare(b.route) || a.source.localeCompare(b.source));
}

function detectForms(files: SourceFile[]): FormFinding[] {
  const results: FormFinding[] = [];
  let counter = 0;
  for (const file of files) {
    const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    for (const match of file.content.matchAll(formRegex)) {
      const attrs = match[1] ?? '';
      const body = match[2] ?? '';
      const method = /\bmethod\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toUpperCase();
      const action = /\baction\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      const fields = [...body.matchAll(/<(?:input|select|textarea)\b[^>]*\b(?:name|id)\s*=\s*["']([^"']+)["']/gi)].map((value) => bounded(value[1] ?? '', 120)).filter(Boolean);
      results.push({ id: `form-${++counter}`, source: file.relativePath, method, action: action ? bounded(action, 240) : undefined, fields: [...new Set(fields)].slice(0, 100), confidence: 'high', evidence: sourceEvidence(file, match.index ?? 0, 'high', 'HTML/JSX form') });
    }
    for (const match of file.content.matchAll(/\b(?:useForm|FormBuilder\.group|FormGroup|react-hook-form|Formik)\b/gi)) {
      results.push({ id: `form-${++counter}`, source: file.relativePath, fields: [], confidence: 'medium', evidence: sourceEvidence(file, match.index ?? 0, 'medium', 'framework form API') });
    }
  }
  return results.slice(0, 2_000);
}

function detectApiCandidates(files: SourceFile[]): ApiCandidate[] {
  const results: ApiCandidate[] = [];
  const patterns: Array<[RegExp, (match: RegExpMatchArray) => { method: string; endpoint: string } | undefined, DiscoveryConfidence, string]> = [
    [/\bfetch\s*\(\s*["']([^"']+)["'](?:\s*,\s*\{[\s\S]{0,500}?\bmethod\s*:\s*["']([^"']+)["'])?/gi, (match) => ({ method: (match[2] ?? 'GET').toUpperCase(), endpoint: match[1] ?? '' }), 'high', 'fetch call'],
    [/\baxios\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi, (match) => ({ method: (match[1] ?? 'GET').toUpperCase(), endpoint: match[2] ?? '' }), 'high', 'axios call'],
    [/\b(?:api|http|client)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi, (match) => ({ method: (match[1] ?? 'GET').toUpperCase(), endpoint: match[2] ?? '' }), 'medium', 'HTTP client call'],
    [/\b(?:dio|Dio\(\))\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi, (match) => ({ method: (match[1] ?? 'GET').toUpperCase(), endpoint: match[2] ?? '' }), 'high', 'Dio call'],
    [/\bhx-(get|post|put|patch|delete)\s*=\s*["']([^"']+)["']/gi, (match) => ({ method: (match[1] ?? 'GET').toUpperCase(), endpoint: match[2] ?? '' }), 'high', 'HTMX request'],
  ];

  for (const file of files) {
    for (const [pattern, map, confidence, detail] of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      for (const match of file.content.matchAll(regex)) {
        const mapped = map(match);
        if (!mapped) continue;
        const endpoint = bounded(mapped.endpoint, 500);
        if (!endpoint || /^(?:data:|javascript:)/i.test(endpoint)) continue;
        results.push({ method: mapped.method, endpoint, source: file.relativePath, confidence, evidence: sourceEvidence(file, match.index ?? 0, confidence, detail) });
      }
    }
  }

  return dedupeBy(results, (item) => `${item.method}\u0000${item.endpoint}\u0000${item.source}`).slice(0, 4_000);
}

function detectMocks(files: SourceFile[]): MockSourceFinding[] {
  const results: MockSourceFinding[] = [];
  for (const file of files) {
    const lower = file.relativePath.toLowerCase();
    const fileKind: MockSourceFinding['kind'] | undefined = /(?:^|\/)(?:__mocks__|mocks?)(?:\/|$)/.test(lower) || /(?:^|[._-])mock(?:[._-]|$)/.test(lower) ? 'mock-file'
      : /(?:^|\/)(?:fixtures?)(?:\/|$)/.test(lower) || /(?:^|[._-])fixture(?:[._-]|$)/.test(lower) ? 'fixture'
        : /(?:^|[._-])stub(?:[._-]|$)/.test(lower) ? 'stub'
          : lower.endsWith('.json') && /(?:sample|demo|fake|seed|data)/.test(lower) ? 'local-json' : undefined;
    if (fileKind) results.push({ source: file.relativePath, kind: fileKind, confidence: 'high', evidence: { path: file.relativePath, confidence: 'high', detail: 'mock/fixture filename or directory' } });

    const libraryPatterns: Array<[RegExp, string]> = [
      [/\b(?:msw|Mock Service Worker)\b/i, 'MSW'], [/\bjson-server\b/i, 'json-server'], [/\bMirageJS\b|from\s+['"]miragejs['"]/i, 'MirageJS'],
      [/\b(?:mockImplementation|mockResolvedValue|vi\.mock|jest\.mock)\b/i, 'test mock API'],
    ];
    for (const [pattern, detail] of libraryPatterns) {
      const match = pattern.exec(file.content);
      if (match) results.push({ source: file.relativePath, kind: 'mock-library', confidence: 'medium', evidence: sourceEvidence(file, match.index, 'medium', detail) });
    }
    for (const match of file.content.matchAll(/\b(?:mockData|fakeData|mockResponse|dummyData|sampleData)\b/gi)) {
      results.push({ source: file.relativePath, kind: 'inline-mock', confidence: 'medium', evidence: sourceEvidence(file, match.index ?? 0, 'medium', 'inline mock-like identifier') });
    }
  }
  return dedupeBy(results, (item) => `${item.source}\u0000${item.kind}`).slice(0, 2_000);
}

function detectState(files: SourceFile[]): StateFinding[] {
  const results: StateFinding[] = [];
  const patterns: Array<[RegExp, string, DiscoveryConfidence]> = [
    [/\buseState\s*(?:<[^>]+>)?\s*\([^)]*\)/gi, 'React useState', 'medium'],
    [/\bcreateSlice\s*\(\s*\{[\s\S]{0,300}?\bname\s*:\s*["']([^"']+)["']/gi, 'Redux Toolkit', 'high'],
    [/\bdefineStore\s*\(\s*["']([^"']+)["']/gi, 'Pinia', 'high'],
    [/\b(?:create|createStore)\s*\(\s*\([^)]*\)\s*=>\s*\(\{/gi, 'Zustand-like store', 'low'],
    [/\b(?:ChangeNotifier|StateNotifier|Bloc|Cubit)\b/gi, 'Flutter state', 'medium'],
  ];
  for (const file of files) {
    for (const [pattern, mechanism, confidence] of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      for (const match of file.content.matchAll(regex)) {
        const key = bounded(match[1] ?? `${mechanism}@${lineFor(file.content, match.index ?? 0)}`, 140);
        results.push({ key, source: file.relativePath, mechanism, confidence, evidence: sourceEvidence(file, match.index ?? 0, confidence, mechanism) });
      }
    }
  }
  return dedupeBy(results, (item) => `${item.source}\u0000${item.mechanism}\u0000${item.key}`).slice(0, 3_000);
}

function inferEntities(api: ApiCandidate[], mocks: MockSourceFinding[], forms: FormFinding[]): EntityCandidate[] {
  const sources = new Map<string, Set<string>>();
  const add = (raw: string, source: string) => {
    const name = singularize(raw);
    if (!name || name.length < 2 || /^(api|v\d+|auth|login|logout|search|health|status|assets?)$/i.test(name)) return;
    const key = name.toLowerCase();
    const set = sources.get(key) ?? new Set<string>();
    set.add(source);
    sources.set(key, set);
  };
  for (const item of api) {
    const pathname = item.endpoint.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0] ?? '';
    for (const segment of pathname.split('/').filter(Boolean)) add(segment, item.source);
  }
  for (const item of mocks) add(path.basename(item.source).replace(/\.[^.]+$/, ''), item.source);
  for (const item of forms) {
    for (const field of item.fields) {
      if (/Id$/i.test(field) && field.length > 2) add(field.slice(0, -2), item.source);
    }
  }
  return [...sources.entries()].map(([name, set]) => ({ name, confidence: set.size >= 2 ? 'high' as const : 'medium' as const, sources: [...set].sort().slice(0, 20) }))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500);
}

export async function discoverFrontend(rootDirectory: string, options: FrontendDiscoveryOptions = {}): Promise<FrontendDiscoveryResult> {
  const rootDir = path.resolve(rootDirectory);
  const rootInfo = await stat(rootDir);
  if (!rootInfo.isDirectory()) throw new Error('frontend discovery root must be a directory');
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, 50_000));
  const maxFileBytes = Math.max(1_024, Math.min(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 5_000_000));
  const { files, skipped } = await collectFiles(rootDir, { maxFiles, maxFileBytes, includeExtensions: options.includeExtensions });
  const languages: Record<string, number> = {};
  for (const file of files) languages[file.language] = (languages[file.language] ?? 0) + 1;
  const frameworks = detectFrameworks(files);
  const routes = detectRoutes(files);
  const forms = detectForms(files);
  const apiCandidates = detectApiCandidates(files);
  const mockSources = detectMocks(files);
  const state = detectState(files);
  const entities = inferEntities(apiCandidates, mockSources, forms);
  const unresolvedQuestions: string[] = [];
  if (frameworks.length === 0) unresolvedQuestions.push('Frontend framework was not confidently identified. Confirm the runtime/framework before backend generation.');
  if (apiCandidates.length === 0) unresolvedQuestions.push('No concrete API calls were identified. Confirm whether the frontend is fully mocked, static, or uses an unsupported client abstraction.');
  if (mockSources.length > 0) unresolvedQuestions.push('Mock sources were detected. Decide whether each mock should be deleted, retained temporarily, or migrated into real seed/demo data.');
  if (skipped.fileLimitReached) unresolvedQuestions.push('Discovery reached the configured file limit. Increase the limit or narrow the project root before treating the inventory as complete.');

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectName: path.basename(rootDir),
    filesScanned: files.length,
    bytesScanned: files.reduce((total, file) => total + file.size, 0),
    skipped,
    languages: Object.fromEntries(Object.entries(languages).sort(([a], [b]) => a.localeCompare(b))),
    frameworks,
    routes,
    forms,
    apiCandidates,
    mockSources,
    state,
    entities,
    unresolvedQuestions,
  };
}
