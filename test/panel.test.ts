import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WslService, type ServiceStatus } from '../src/service.js';
import { createController } from '../src/routes.js';
import { BridgeError } from '../src/errors.js';
import { en } from '../src/i18n/en.js';
import { ru } from '../src/i18n/ru.js';
import { zhCN } from '../src/i18n/zh-CN.js';
import { CLIENT_DICTIONARIES } from '../src/i18n/client-strings.js';
import { setClientLocale, ct, formatDate, clientLocale } from '../src/i18n/client.js';
import { LOCALES } from '../src/i18n/index.js';
import type { ConnectionPool } from '../src/connector.js';

// Tests run from the repository root; sources stay outside the build output.
const root = process.cwd();

/** Panel modules that render user-facing text. */
const PANEL_SOURCES = [
  'src/page.tsx',
  'src/permissions-ui.tsx',
  'src/inheritance-ui.tsx',
  'src/handoff-dialog.tsx',
  'src/workspace-dialogs.tsx',
  'src/sidebar.tsx',
  'src/conversations.tsx',
  'src/components.tsx',
];

const pool = {
  call: async () => {
    throw new BridgeError('NOT_CONNECTED', 'no connection in tests');
  },
  snapshot: () => ({ connections: [] }),
  disconnect: async () => {},
  close: async () => {},
  get: async () => {
    throw new BridgeError('NOT_CONNECTED', 'no connection in tests');
  },
} as unknown as ConnectionPool;

async function makeService(directory: string): Promise<WslService> {
  const service = new WslService(
    { settingsFile: path.join(directory, 'settings.json') },
    { pool, listDistros: async () => [] },
  );
  await service.initialized;
  return service;
}

async function withService(run: (service: WslService) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-native-panel-'));
  try {
    const service = await makeService(directory);
    try {
      await run(service);
    } finally {
      await service.close();
    }
  } finally {
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  }
}

test('every literal panel translation key exists in all three locales', async () => {
  const keys = new Set<string>();
  for (const file of PANEL_SOURCES) {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?<![A-Za-z])ct\('([A-Za-z0-9_.-]+)'/g)) keys.add(match[1] ?? '');
    // Typed key maps keep dynamic lookups honest.
    for (const match of source.matchAll(/:\s*'((?:ui|client|handoff)\.[A-Za-z0-9_.-]+)'/g)) {
      keys.add(match[1] ?? '');
    }
  }
  assert.ok(keys.size > 100, `expected many panel keys, found ${keys.size}`);
  for (const key of [...keys].sort()) {
    assert.ok(key in en, `en is missing ${key}`);
    assert.ok(key in ru, `ru is missing ${key}`);
    assert.ok(key in zhCN, `zh-CN is missing ${key}`);
  }
});

test('the browser dictionary slice carries every key the panel can render', async () => {
  const referenced = new Set<string>();
  for (const file of PANEL_SOURCES) {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?<![A-Za-z])ct\('([A-Za-z0-9_.-]+)'/g)) referenced.add(match[1] ?? '');
  }
  for (const locale of LOCALES) {
    const slice = CLIENT_DICTIONARIES[locale] as Record<string, string>;
    for (const key of referenced) {
      assert.ok(key in slice, `${locale} slice is missing ${key}`);
    }
  }
});

test('the panel translator switches locale and falls back to English', () => {
  for (const locale of LOCALES) {
    setClientLocale(locale);
    assert.equal(clientLocale(), locale);
    assert.ok(ct('ui.permissions.title').length > 0);
    // A regional tag must resolve to its base locale.
    setClientLocale(`${locale}-extra`);
    assert.equal(clientLocale(), locale);
  }
  setClientLocale('en');
  assert.equal(ru['permissions.mode.protected'], 'Защищённый (Protected)');
  assert.notEqual(ru['permissions.mode.protected'], en['permissions.mode.protected']);
});

test('dates render with the active locale', () => {
  const stamp = Date.UTC(2026, 0, 2, 3, 4);
  setClientLocale('ru');
  const russian = formatDate(stamp);
  setClientLocale('zh-CN');
  const chinese = formatDate(stamp);
  setClientLocale('en');
  const english = formatDate(stamp);
  assert.notEqual(russian, english);
  assert.notEqual(chinese, english);
  assert.ok(russian.length > 0 && chinese.length > 0);
  setClientLocale('en');
});

test('the status payload exposes the permission mode window the panel renders', async () => {
  await withService(async (service) => {
    const controller = createController(service);
    const status = (await controller.dispatch('status')) as ServiceStatus;
    assert.equal(status.permissions.mode, 'protected');
    assert.equal(status.permissions.grants.length, 0);
    await controller.close();
  });
});

test('the control route can switch modes, add and revoke grants', async () => {
  await withService(async (service) => {
    const controller = createController(service);
    const trusted = (await controller.dispatch('permissions/mode', { mode: 'trusted' })) as {
      mode: string;
      modeExpiresAt: number | null;
    };
    assert.equal(trusted.mode, 'trusted');
    assert.equal(trusted.modeExpiresAt, null);

    const full = (await controller.dispatch('permissions/mode', { mode: 'full-access', confirm: 'FULL ACCESS' })) as {
      mode: string;
      modeIssuedAt: number | null;
      modeExpiresAt: number | null;
    };
    assert.equal(full.mode, 'full-access');
    assert.ok(full.modeIssuedAt && full.modeExpiresAt);
    assert.ok(full.modeExpiresAt > full.modeIssuedAt);

    const grant = (await controller.dispatch('permissions/grant', {
      capability: 'exec',
      target: 'wsl',
      hours: 2,
    })) as { id: string; target: string; expiresAt: number | null };
    assert.equal(grant.target, 'wsl');
    assert.ok(grant.expiresAt);

    const revoke = (await controller.dispatch('permissions/revoke', { id: grant.id })) as { removed: boolean };
    assert.equal(revoke.removed, true);
    const after = (await controller.dispatch('status')) as ServiceStatus;
    assert.deepEqual(after.permissions.grants, []);
    await controller.close();
  });
});

test('the control route rejects unknown modes and unconfirmed full access', async () => {
  await withService(async (service) => {
    const controller = createController(service);
    await assert.rejects(
      controller.dispatch('permissions/mode', { mode: 'root' }),
      (error: BridgeError) => error.code === 'INVALID_ARGUMENT' || error.code === 'FORBIDDEN_VALUE',
    );
    await assert.rejects(controller.dispatch('permissions/mode', { mode: 'full-access' }));
    const status = (await controller.dispatch('status')) as ServiceStatus;
    assert.equal(status.permissions.mode, 'protected');
    await controller.close();
  });
});
