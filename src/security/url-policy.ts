export function isSecureServiceEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isSecureVisualEndpoint(value: string): boolean {
  return isSecureServiceEndpoint(value);
}
