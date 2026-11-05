import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WslService, type ServiceStatus } from '../src/service.js';
import { createController, registerRoutes, trusted } from '../src/routes.js';
import { BridgeError } from '../src/errors.js';
import { getLocale, setLocale } from '../src/i18n/index.js';
import type { ConnectionPool } from '../src/connector.js';

/** Pool stub: the routes under test never open a real connection. */
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

/** Create a service bound to a throwaway settings file. */
async function makeService(directory: string): Promise<WslService> {
  const service = new WslService(
    { settingsFile: path.join(directory, 'settings.json') },
    { pool, listDistros: async () => [] },
  );
  await service.initialized;
  return service;
}

test('status reports the strict default and no inheritance on Linux', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-native-routes-'));
  t.after(async () => {
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  });
  const service = await makeService(directory);
  const controller = createController(service);
  const status = (await controller.dispatch('status')) as ServiceStatus & {
    native: { inheritance: { available: boolean }; running: unknown };
    handoffs: unknown[];
  };
  assert.equal(status.mode, process.platform === 'win32' ? 'windows-host' : process.env.WSL_DISTRO_NAME ? 'wsl-host' : 'unsupported');
  assert.equal(status.permissions.mode, 'protected');
  assert.deepEqual(status.permissions.grants, []);
  assert.equal(status.native.inheritance.available, false);
  assert.equal(status.native.running, null);
  assert.deepEqual(status.handoffs, []);
  await controller.close();
  await service.close();
});

test('preferences persist a language choice and switch the process locale', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-native-prefs-'));
  t.after(async () => {
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  });
  const service = await makeService(directory);
  const controller = createController(service);
  const previous = getLocale();
  t.after(() => setLocale(previous));
  const updated = (await controller.dispatch('preferences', { locale: 'ru' })) as { locale: string };
  assert.equal(updated.locale, 'ru');
  assert.equal(getLocale(), 'ru');
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')) as {
    preferences: { locale: string };
  };
  assert.equal(saved.preferences.locale, 'ru');
  await assert.rejects(
    () => controller.dispatch('preferences', { locale: 'fr-FR' }),
    (error: unknown) => error instanceof BridgeError,
  );
  await controller.close();
  await service.close();
});

test('unknown routes and oversized payloads are refused', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-native-routes2-'));
  t.after(async () => {
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  });
  const service = await makeService(directory);
  const controller = createController(service);
  await assert.rejects(
    () => controller.dispatch('nope'),
    (error: unknown) => error instanceof BridgeError && error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => controller.dispatch('status', { padding: 'x'.repeat(17000) }),
    (error: unknown) => error instanceof BridgeError && error.code === 'INVALID_ARGUMENT',
  );
  await controller.close();
  await service.close();
});

test('only same-origin loopback hosts are trusted', () => {
  const request = (headers: Record<string, string>): IncomingMessage => ({ headers }) as unknown as IncomingMessage;
  assert.equal(trusted(request({ host: '127.0.0.1:8080' }), 8080), true);
  assert.equal(trusted(request({ host: 'localhost:8080', origin: 'http://localhost:8080' }), 8080), true);
  assert.equal(trusted(request({ host: '127.0.0.1:9090' }), 8080), false);
  assert.equal(trusted(request({ host: 'example.com:8080' }), 8080), false);
  assert.equal(trusted(request({ host: '127.0.0.1:8080', origin: 'http://evil.example' }), 8080), false);
  assert.equal(trusted(request({ host: '127.0.0.1:8080', 'sec-fetch-site': 'cross-site' }), 8080), false);
});

test('the HTTP carrier requires the panel token and the JSON content type', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-native-http-'));
  t.after(async () => {
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  });
  const service = await makeService(directory);
  const controller = createController(service);
  let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
  const server = {
    port: 8080,
    register: (options: {
      handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
    }): (() => void) => {
      handler = options.handler;
      return () => {};
    },
  };
  registerRoutes(server, service, undefined, controller);
  assert.ok(handler);

  const call = async (
    headers: Record<string, string>,
    body: string,
    method = 'POST',
  ): Promise<{ status: number; payload: Record<string, unknown> }> => {
    const stream = new PassThrough();
    const request = stream as unknown as IncomingMessage;
    Object.assign(request, { method, url: '/dsh-wsl-native/status', headers });
    let status = 0;
    let text = '';
    const response = {
      headersSent: false,
      writeHead(value: number): void {
        status = value;
        response.headersSent = true;
      },
      end(value?: string): void {
        text = String(value ?? '');
      },
    };
    const pending = handler?.(request, response as unknown as ServerResponse);
    stream.end(body);
    await pending;
    return { status, payload: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  const unauthenticated = await call({ host: '127.0.0.1:8080', 'content-type': 'application/json' }, '{}');
  assert.equal(unauthenticated.status, 401);

  const missingToken = await call(
    { host: '127.0.0.1:8080', 'content-type': 'application/json' },
    JSON.stringify({}),
  );
  assert.equal(missingToken.status, 401);

  const wrongType = await call(
    { host: '127.0.0.1:8080', 'content-type': 'text/plain', 'x-dsh-wsl-token': 'x' },
    '{}',
    'GET',
  );
  assert.equal(wrongType.status, 401);

  await controller.close();
  await service.close();
});
