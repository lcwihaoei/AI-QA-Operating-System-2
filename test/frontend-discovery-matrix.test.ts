import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverFrontend } from '../src/backend/frontend-discovery.js';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function project(name: string, files: Record<string, string>): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), `aiqa-discovery-${name}-`));
  roots.push(base);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(base, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return base;
}

const matrix = [
  {
    name: 'react', framework: 'React', route: '/users', endpoint: '/api/users', mock: 'src/mock-users.ts',
    files: {
      'package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      'src/App.tsx': `import React,{useState} from 'react';\nexport function App(){const [q]=useState('');return <><Route path="/users" element={<div/>}/><form action="/users" method="post"><input name="email"/></form></>}\nfetch('/api/users');`,
      'src/mock-users.ts': `export const mockData=[{id:1}];`,
    },
  },
  {
    name: 'vue', framework: 'Vue', route: '/projects', endpoint: '/api/projects', mock: 'fixtures/projects.json',
    files: {
      'package.json': JSON.stringify({ dependencies: { vue: '^3.5.0' } }),
      'src/App.vue': `<template><a href="/projects">Projects</a></template><script setup>fetch('/api/projects')</script>`,
      'fixtures/projects.json': '[{"id":1}]',
    },
  },
  {
    name: 'svelte', framework: 'Svelte', route: '/reports', endpoint: '/api/reports', mock: 'mocks/reports.json',
    files: {
      'package.json': JSON.stringify({ dependencies: { svelte: '^5.0.0' } }),
      'src/App.svelte': `<svelte:head><title>Reports</title></svelte:head><a href="/reports">Reports</a><script>fetch('/api/reports')</script>`,
      'mocks/reports.json': '[{"id":1}]',
    },
  },
  {
    name: 'angular', framework: 'Angular', route: '/admin', endpoint: '/api/admins', mock: 'src/admin.fixture.ts',
    files: {
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^21.0.0' } }),
      'src/app.component.ts': `import {Component} from '@angular/core';\n@Component({template:'<a href="/admin">Admin</a>'}) export class AppComponent { load(){ return this.http.get('/api/admins') } }`,
      'src/admin.fixture.ts': `export const sampleData=[{id:1}];`,
    },
  },
] as const;

describe('Beta.8 frontend discovery framework dogfood matrix', () => {
  for (const entry of matrix) {
    it(`discovers ${entry.name} evidence without framework-specific execution`, async () => {
      const root = await project(entry.name, entry.files);
      const result = await discoverFrontend(root);
      expect(result.frameworks.some((item) => item.name === entry.framework && item.confidence === 'high')).toBe(true);
      expect(result.routes.some((item) => item.route === entry.route)).toBe(true);
      expect(result.apiCandidates.some((item) => item.endpoint === entry.endpoint)).toBe(true);
      expect(result.mockSources.some((item) => item.source === entry.mock)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(root);
    });
  }

  it('still inventories a vanilla frontend while explicitly reporting that no framework was confirmed', async () => {
    const root = await project('vanilla', {
      'index.html': `<a href="/signup">Sign up</a><form method="post" action="/signup"><input name="email"></form><script src="app.js"></script>`,
      'app.js': `fetch('/api/profiles'); const fakeData=[{id:1}];`,
      'demo-data.json': '[{"id":1}]',
    });
    const result = await discoverFrontend(root);
    expect(result.frameworks).toHaveLength(0);
    expect(result.routes.some((item) => item.route === '/signup')).toBe(true);
    expect(result.forms.some((item) => item.fields.includes('email'))).toBe(true);
    expect(result.apiCandidates.some((item) => item.endpoint === '/api/profiles')).toBe(true);
    expect(result.mockSources.some((item) => item.source === 'demo-data.json')).toBe(true);
    expect(result.unresolvedQuestions.some((question) => /framework was not confidently identified/i.test(question))).toBe(true);
  });

  it('ignores secret-like files and dependency/build trees across the matrix', async () => {
    const root = await project('adversarial', {
      'src/app.ts': `fetch('/api/items');`,
      '.env.production': 'API_TOKEN=do-not-read',
      'config/service-account.json': '{"private_key":"do-not-read"}',
      'node_modules/pkg/index.js': `fetch('/api/should-not-appear')`,
      'dist/bundle.js': `fetch('/api/should-not-appear-either')`,
    });
    const result = await discoverFrontend(root);
    const serialized = JSON.stringify(result);
    expect(result.apiCandidates.map((item) => item.endpoint)).toEqual(['/api/items']);
    expect(result.skipped.sensitiveFiles).toBe(2);
    expect(result.skipped.ignoredDirectories).toBeGreaterThanOrEqual(2);
    expect(serialized).not.toContain('do-not-read');
    expect(serialized).not.toContain('should-not-appear');
  });
});
