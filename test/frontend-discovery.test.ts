import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverFrontend } from '../src/backend/frontend-discovery.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiqa-frontend-discovery-'));
  dirs.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'mocks'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0', axios: '^1.0.0' } }));
  await writeFile(path.join(root, 'src', 'App.tsx'), `import React, { useState } from 'react';\nimport axios from 'axios';\nexport function App(){ const [name] = useState(''); return <><Route path="/users" element={<div/>}/><form method="post" action="/users"><input name="email"/><button>Save</button></form></> }\naxios.get('/api/users');`);
  await writeFile(path.join(root, 'mocks', 'users.json'), JSON.stringify([{ id: 1, email: 'demo@example.test' }]));
  await writeFile(path.join(root, '.env'), 'SECRET_SHOULD_NOT_BE_SCANNED=top-secret');
  return root;
}

describe('Beta.8 frontend discovery', () => {
  it('inventories routes, forms, APIs, mocks and entities without persisting absolute paths or secrets', async () => {
    const root = await fixture();
    const result = await discoverFrontend(root);
    const serialized = JSON.stringify(result);

    expect(result.frameworks.some((item) => item.name === 'React')).toBe(true);
    expect(result.routes.some((item) => item.route === '/users')).toBe(true);
    expect(result.forms.some((item) => item.fields.includes('email'))).toBe(true);
    expect(result.apiCandidates.some((item) => item.method === 'GET' && item.endpoint === '/api/users')).toBe(true);
    expect(result.mockSources.some((item) => item.source === 'mocks/users.json')).toBe(true);
    expect(result.entities.some((item) => item.name === 'user')).toBe(true);
    expect(result.skipped.sensitiveFiles).toBe(1);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('top-secret');
  });

  it('keeps a hard file limit and reports incomplete discovery instead of pretending completeness', async () => {
    const root = await fixture();
    const result = await discoverFrontend(root, { maxFiles: 1 });
    expect(result.filesScanned).toBe(1);
    expect(result.skipped.fileLimitReached).toBe(true);
    expect(result.unresolvedQuestions.some((question) => /file limit/i.test(question))).toBe(true);
  });
});
