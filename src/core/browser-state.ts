import type { BrowserContext } from '@playwright/test';

export type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
