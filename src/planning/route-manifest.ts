export interface RouteManifestDocument {
  routes: string[];
}

const MAX_ROUTES = 200;
const MAX_ROUTE_CHARS = 2_048;

function assertRouteText(value: unknown, index: number): string {
  if (typeof value !== 'string') throw new Error(`route manifest entry ${index + 1} must be a string`);
  const route = value.trim();
  if (!route) throw new Error(`route manifest entry ${index + 1} is empty`);
  if (route.length > MAX_ROUTE_CHARS) throw new Error(`route manifest entry ${index + 1} exceeds ${MAX_ROUTE_CHARS} characters`);
  return route;
}

export function parseRouteManifest(text: string): RouteManifestDocument {
  if (text.length > 500_000) throw new Error('route manifest exceeds 500,000 characters');
  const trimmed = text.trim();
  if (!trimmed) return { routes: [] };

  let values: unknown[];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      values = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { routes?: unknown }).routes)) {
      values = (parsed as { routes: unknown[] }).routes;
    } else {
      throw new Error('route manifest JSON must be an array or an object with a routes array');
    }
  } else {
    values = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }

  if (values.length > MAX_ROUTES) throw new Error(`route manifest may contain at most ${MAX_ROUTES} routes`);
  return { routes: values.map(assertRouteText) };
}

export function normalizeRouteSeeds(startUrl: string, routes: string[], sameOriginOnly = true): string[] {
  const start = new URL(startUrl);
  if (!['http:', 'https:'].includes(start.protocol)) throw new Error('start URL must use HTTP or HTTPS');
  const normalized = new Set<string>();

  for (const [index, raw] of routes.entries()) {
    const route = assertRouteText(raw, index);
    let url: URL;
    try {
      url = new URL(route, start);
    } catch {
      throw new Error(`route manifest entry ${index + 1} is not a valid URL or route`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`route manifest entry ${index + 1} uses a disallowed protocol`);
    if (url.username || url.password) throw new Error(`route manifest entry ${index + 1} must not contain URL credentials`);
    if (sameOriginOnly && url.origin !== start.origin) throw new Error(`route manifest entry ${index + 1} is cross-origin`);
    url.hash = '';
    normalized.add(url.toString());
  }

  return [...normalized];
}
