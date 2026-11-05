import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NativeLauncher, type LauncherProgress, type PreparedRuntime, type RunningRuntime } from './launcher.js';
import { BridgeError, ensure, errorData } from './errors.js';
import { environmentKey, type CallOptions, type ServiceStatus, type WslService, type WslSettings } from './service.js';
import { handoffUrl, appOrigin, type Handoff } from './handoff.js';
import { signHandoff, verifyHandoff } from './handoff-auth.js';
import { ProfileInheritance, type InheritanceStatus } from './inheritance.js';
import { createUserSurfaceAuthority } from './permissions/index.js';
import { t } from './i18n/index.js';

export const PREFIX = '/dsh-wsl-native';

/** Request payload accepted by the panel and the CLI. */
type Params = Record<string, unknown>;

/** One handoff in flight, shared with the browser panel. */
interface HandoffEntry extends Handoff {
  settings: WslSettings;
  state: 'preparing' | 'starting' | 'ready' | 'failed';
  startedAt: number;
  readyAt?: number;
  url?: string;
  error?: string;
}

/** Per-environment launcher and its current operation. */
interface EnvironmentEntry {
  settings: WslSettings;
  launcher: NativeLauncher;
  operation: Promise<unknown> | null;
  handoff: HandoffEntry | null;
  starting: boolean;
  parentOrigin?: string | null;
}

/** Snapshot of one environment for the status route. */
interface EnvironmentSnapshot {
  settings: WslSettings;
  running: (RunningRuntime & { openUrl: string }) | null;
  progress: LauncherProgress;
  preparing: boolean;
  starting: boolean;
}

/** Structural view of the DSH connection carrier. */
export interface ConnectionLike {
  fetch: {
    register(options: {
      path: string;
      methods: string[];
      requestBody: 'buffered';
      fetch: (request: Request) => Promise<Response>;
    }): () => Promise<void> | void;
  };
  requestRejection?: (request: IncomingMessage) => number | undefined;
}

/** Structural view of the DSH web server carrier. */
export interface WebServerLike {
  port: number;
  register(options: {
    kind: 'prefix';
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  }): () => Promise<void> | void;
}

/** Panel-facing controller shared by the HTTP and RPC carriers. */
export interface BridgeController {
  dispatch(route: string, params?: Params, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

/** Only same-origin requests from the panel are accepted. */
export function trusted(request: IncomingMessage, port: number): boolean {
  try {
    const host = request.headers.host;
    if (typeof host !== 'string') return false;
    const url = new URL(`http://${host}`);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.port !== String(port) ||
      url.username ||
      url.password ||
      url.pathname !== '/'
    ) {
      return false;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== url.origin) return false;
    const site = request.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none';
  } catch {
    return false;
  }
}

async function jsonBody(request: IncomingMessage): Promise<Params> {
  ensure(
    request.headers['content-type']?.split(';')[0] === 'application/json',
    'CONTENT_TYPE',
    'routes.contentType',
  );
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += (chunk as Buffer).length;
    ensure(length <= 16384, 'BODY_TOO_LARGE', 'routes.bodyTooLarge');
    chunks.push(chunk as Buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError('INVALID_JSON', t('routes.invalidJson'));
  }
  ensure(!!value && typeof value === 'object' && !Array.isArray(value), 'INVALID_JSON', 'routes.invalidJsonBody');
  return value as Params;
}

function reply(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

/** Read an optional string field from an untrusted payload. */
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Read an optional integer field from an untrusted payload. */
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

/** Build resolved call options from an untrusted payload. */
function callOptions(params: Params, signal?: AbortSignal): CallOptions {
  const directory = text(params.directory) ?? text(params.cwd);
  return {
    distro: text(params.distro),
    user: text(params.user),
    directory,
    signal,
  };
}

/**
 * Panel controller. Every environment gets its own launcher so two
 * distributions can be prepared independently, while the worker connections
 * stay shared through the service pool.
 */
export function createController(
  service: WslService,
  options: { createLauncher?: (scoped: WslService) => NativeLauncher } = {},
): BridgeController & {
  environments: Map<string, EnvironmentEntry>;
  handoffs: Map<string, HandoffEntry>;
} {
  const createLauncher = options.createLauncher ?? ((scoped: WslService): NativeLauncher => new NativeLauncher(scoped));
  const environments = new Map<string, EnvironmentEntry>();
  const handoffs = new Map<string, HandoffEntry>();
  let closed = false;

  const environment = (settings: WslSettings): EnvironmentEntry => {
    const key = environmentKey(settings);
    let entry = environments.get(key);
    if (!entry) {
      entry = {
        settings: { ...settings },
        launcher: createLauncher(service.scope(settings)),
        operation: null,
        handoff: null,
        starting: false,
      };
      environments.set(key, entry);
    }
    entry.settings = { ...settings };
    return entry;
  };

  const handoffPayload = (
    id: string,
    settings: WslSettings,
    parentOrigin: string | null,
  ): Handoff => ({ id, distro: settings.distro, user: settings.user, directory: settings.directory, parentOrigin });

  const snapshot = (entry: EnvironmentEntry, settings: WslSettings = entry.settings): EnvironmentSnapshot => {
    const running = entry.launcher.running;
    return {
      settings: entry.settings,
      running: running
        ? {
            ...running,
            openUrl: handoffUrl(
              running.url,
              signHandoff(handoffPayload(randomUUID(), settings, entry.parentOrigin ?? null), entry.launcher.handoffSecret),
            ),
          }
        : null,
      progress: entry.launcher.progress,
      preparing: !!entry.launcher.preparing,
      starting: entry.starting,
    };
  };

  const selected = async (
    params: Params,
    signal?: AbortSignal,
  ): Promise<{ settings: WslSettings; entry: EnvironmentEntry }> => {
    const result = await service.switchEnvironment(callOptions(params, signal), { signal });
    return { ...result, entry: environment(result.settings) };
  };

  return {
    environments,
    handoffs,
    async close() {
      closed = true;
      await Promise.allSettled(
        [...environments.values()].map(async (entry) => {
          await entry.launcher.close();
          await entry.operation;
        }),
      );
    },
    async dispatch(route, params = {}, signal) {
      ensure(!closed, 'CONNECTION_CLOSED', 'connector.pluginStopped');
      ensure(
        !!params &&
          typeof params === 'object' &&
          !Array.isArray(params) &&
          Buffer.byteLength(JSON.stringify(params)) <= 16384,
        'INVALID_ARGUMENT',
        'routes.requestObject',
      );
      const path = route.replace(/^\//, '');
      if (path === 'status') {
        const status: ServiceStatus = await service.status();
        await Promise.all([...environments.values()].map((entry) => entry.launcher.getRunning()));
        const active = environments.get(environmentKey(status.settings));
        return {
          ...status,
          parentOrigin: appOrigin(process.env.DSH_WSL_PARENT_ORIGIN),
          launchDirectory: process.env.DSH_WSL_DIRECTORY || null,
          native: {
            inheritance: await new ProfileInheritance(service).status(),
            ...(active
              ? snapshot(active, status.settings)
              : {
                  running: null,
                  progress: { phase: 'idle' as const, text: '' },
                  preparing: false,
                  starting: false,
                }),
            instances: [...environments.values()].map((entry) => snapshot(entry)),
          },
          handoffs: [...handoffs.values()],
        };
      }
      if (path === 'settings') return (await service.switchEnvironment(callOptions(params, signal), { signal })).settings;
      if (path === 'preferences') return service.updatePreferences(params, { signal });
      if (path === 'environment/switch') return service.switchEnvironment(callOptions(params, signal), { signal });
      if (path === 'environment/adopt') {
        ensure(
          verifyHandoff(params as Partial<Handoff>, process.env.DSH_WSL_HANDOFF_SECRET),
          'HANDOFF_INVALID',
          'routes.handoffInvalid',
        );
        return service.switchEnvironment(callOptions(params, signal), { signal });
      }
      if (path === 'connect') {
        return service.ping(
          params.target === 'windows' ? 'windows' : 'wsl',
          { distro: text(params.distro), user: text(params.user), signal },
        );
      }
      if (path === 'disconnect') {
        ensure(
          ![...environments.values()].some((entry) => entry.operation),
          'SETUP_BUSY',
          'routes.startBusy',
        );
        await Promise.all([...environments.values()].map((entry) => entry.launcher.stop()));
        await service.pool.disconnect();
        service.jobs.clear();
        handoffs.clear();
        return { disconnected: true };
      }
      if (path === 'directory/create') {
        const { settings } = await service.resolveEnvironment(
          { distro: text(params.distro), user: text(params.user), directory: text(params.parent) },
          signal,
        );
        return service.call(
          'wsl',
          'directory.create',
          { parent: settings.directory, name: text(params.name) ?? '' },
          { distro: settings.distro, user: settings.user, signal },
        );
      }
      if (path === 'browse') {
        return service.files(
          'wsl',
          'list',
          {
            path: text(params.path) ?? '',
            offset: count(params.offset),
            limit: 200,
            hidden: params.hidden === true,
          },
          { distro: text(params.distro), user: text(params.user), signal },
        );
      }
      if (path === 'open') {
        return service.windows(
          { action: 'open', target: text(params.path) },
          { distro: text(params.distro), user: text(params.user), signal },
        );
      }
      if (path === 'native/enter') {
        ensure(process.platform === 'win32', 'WRONG_HOST', 'routes.unsupportedHost');
        ensure(!params.parentOrigin || appOrigin(params.parentOrigin), 'INVALID_ORIGIN', 'routes.invalidOrigin');
        const { settings, entry } = await selected(params, signal);
        entry.parentOrigin = appOrigin(params.parentOrigin) || entry.parentOrigin || null;
        if (entry.operation) {
          ensure(
            entry.handoff && entry.handoff.settings.directory === settings.directory,
            'START_BUSY',
            'routes.startBusy',
          );
          return { id: entry.handoff.id, settings };
        }
        const handoff: HandoffEntry = {
          ...handoffPayload(randomUUID(), settings, entry.parentOrigin ?? null),
          settings,
          state: 'preparing',
          startedAt: Date.now(),
        };
        entry.handoff = handoff;
        handoffs.set(handoff.id, handoff);
        // A refresh or tab switch must not cancel installation; the plugin lifetime owns it.
        entry.operation = (async () => {
          try {
            let running = await entry.launcher.getRunning();
            if (!running) {
              await entry.launcher.prepare({ distro: settings.distro });
              handoff.state = 'starting';
              entry.starting = true;
              running = await entry.launcher.start({
                distro: settings.distro,
                cwd: settings.directory,
                parentOrigin: handoff.parentOrigin,
              });
            }
            handoff.url = handoffUrl(
              running.url,
              signHandoff(handoffPayload(handoff.id, settings, handoff.parentOrigin), entry.launcher.handoffSecret),
            );
            handoff.state = 'ready';
            handoff.readyAt = Date.now();
          } catch (error) {
            handoff.state = 'failed';
            handoff.error = (error as Error).message;
          } finally {
            entry.starting = false;
            entry.operation = null;
          }
        })();
        for (const [id, item] of handoffs) {
          if (handoffs.size > 16 && ['ready', 'failed'].includes(item.state) && id !== handoff.id) {
            handoffs.delete(id);
          }
        }
        return { id: handoff.id, settings };
      }
      // Permission mutations are only reachable from this authenticated control
      // route: DSH has already verified the desktop/browser session before the
      // carrier invoked us, so the route itself is the user-surface evidence.
      if (path === 'permissions/mode') {
        const authority = createUserSurfaceAuthority({ kind: 'control-route', authenticated: true });
        return service.setPermissionMode(
          {
            mode: text(params.mode) ?? '',
            confirm: text(params.confirm),
            hours: count(params.hours) ?? undefined,
          },
          authority,
        );
      }
      if (path === 'permissions/grant') {
        const authority = createUserSurfaceAuthority({ kind: 'control-route', authenticated: true });
        return service.addPermissionGrant(
          { capability: text(params.capability), target: text(params.target), hours: count(params.hours) },
          authority,
        );
      }
      if (path === 'permissions/revoke') {
        const authority = createUserSurfaceAuthority({ kind: 'control-route', authenticated: true });
        return service.revokePermissionGrant(text(params.id), authority);
      }
      if (path === 'native/inheritance') {
        const { entry } = await selected(params, signal);
        ensure(!entry.operation, 'SETUP_BUSY', 'routes.inheritanceBusy');
        const inheritance: InheritanceStatus = await entry.launcher.inheritance.configure(
          (params.options ?? {}) as Record<string, unknown>,
        );
        return inheritance;
      }
      if (path === 'native/prepare') {
        const { settings, entry } = await selected(params, signal);
        ensure(
          !entry.operation && !(await entry.launcher.getRunning()),
          'SETUP_BUSY',
          'routes.stopBeforePrepare',
        );
        entry.operation = entry.launcher
          .prepare({ distro: settings.distro })
          .then((prepared: PreparedRuntime) => prepared)
          .catch(() => null)
          .finally(() => {
            entry.operation = null;
          });
        return { started: true };
      }
      if (path === 'native/start') {
        const { settings, entry } = await selected(params, signal);
        ensure(!entry.operation, 'START_BUSY', 'routes.startBusy');
        entry.starting = true;
        const port = typeof params.port === 'number' ? params.port : 0;
        entry.operation = entry.launcher.start({
          distro: settings.distro,
          cwd: settings.directory,
          port,
          signal,
          parentOrigin: text(params.parentOrigin),
        });
        try {
          return await entry.operation;
        } finally {
          entry.starting = false;
          entry.operation = null;
        }
      }
      if (path === 'native/stop') {
        const resolved = await service.options(callOptions(params));
        const entry = environments.get(environmentKey(resolved));
        if (!entry) return { stopped: true };
        ensure(!entry.operation, 'START_BUSY', 'routes.startBusy');
        return entry.launcher.stop();
      }
      throw new BridgeError('NOT_FOUND', t('routes.notFound'));
    },
  };
}

/**
 * Exact `/api` routes use DSH's authenticated browser and Desktop carriers.
 * Dedicated RPC channels require a web server and are not carrier-neutral.
 */
export function registerControlRoutes(connection: ConnectionLike, controller: BridgeController): Promise<void> {
  const endpoints = [
    'status',
    'settings',
    'preferences',
    'environment/switch',
    'environment/adopt',
    'connect',
    'disconnect',
    'browse',
    'directory/create',
    'open',
    'native/enter',
    'permissions/mode',
    'permissions/grant',
    'permissions/revoke',
    'native/inheritance',
    'native/prepare',
    'native/start',
    'native/stop',
  ];
  const removers = endpoints.map((endpoint) =>
    connection.fetch.register({
      path: `/api/dsh-wsl-native/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request: Request): Promise<Response> {
        let rpcId = 'invalid-request';
        try {
          ensure(
            request.headers.get('content-type')?.split(';')[0] === 'application/json',
            'CONTENT_TYPE',
            'routes.contentType',
          );
          const body = await request.text();
          ensure(Buffer.byteLength(body) <= 17000, 'BODY_TOO_LARGE', 'routes.bodyTooLarge');
          const parsed = JSON.parse(body) as {
            type?: string;
            rpcId?: string;
            method?: string;
            payload?: Params;
          };
          ensure(
            parsed?.type === 'client-request' &&
              typeof parsed.rpcId === 'string' &&
              parsed.rpcId.length <= 200 &&
              parsed.method === `dsh-wsl-native/${endpoint}`,
            'INVALID_ARGUMENT',
            'routes.rpcFormat',
          );
          rpcId = parsed.rpcId as string;
          const value = await controller.dispatch(endpoint, parsed.payload ?? {}, request.signal);
          return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
        } catch (error) {
          return Response.json({
            type: 'server-response',
            rpcId,
            result: { ok: false, error: { ...errorData(error), details: {} } },
          });
        }
      },
    }),
  );
  return (async () => {
    for (const remove of removers.reverse()) await remove();
  })();
}

/** HTTP carrier used by the embedded panel. */
export function registerRoutes(
  server: WebServerLike,
  service: WslService,
  connection: ConnectionLike | undefined,
  controller: BridgeController = createController(service),
): () => Promise<void> | void {
  const token = randomBytes(32).toString('hex');
  return server.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (request, response) => {
      try {
        if (!trusted(request, server.port)) {
          reply(response, 403, { error: { code: 'FORBIDDEN', message: t('routes.forbidden') } });
          return;
        }
        const rejection = connection?.requestRejection?.(request) ?? (connection?.requestRejection ? undefined : 401);
        if (rejection) {
          reply(response, rejection, {
            error: { code: 'AUTH_REQUIRED', message: t('routes.authRequired') },
          });
          return;
        }
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${server.port}`);
        const route = url.pathname.slice(PREFIX.length);
        if (request.method === 'GET' && route === '/status') {
          reply(response, 200, { ...((await controller.dispatch('status')) as object), csrf: token });
          return;
        }
        if (request.method !== 'POST') {
          reply(response, 404, { error: { code: 'NOT_FOUND', message: t('routes.notFound') } });
          return;
        }
        const supplied = request.headers['x-dsh-wsl-token'];
        ensure(
          typeof supplied === 'string' &&
            supplied.length === token.length &&
            timingSafeEqual(Buffer.from(supplied), Buffer.from(token)),
          'FORBIDDEN',
          'routes.refreshPanel',
        );
        const params = await jsonBody(request);
        reply(response, 200, await controller.dispatch(route, params));
      } catch (error) {
        const code = (error as BridgeError).code;
        if (!response.headersSent) {
          reply(response, code === 'FORBIDDEN' ? 403 : code === 'BODY_TOO_LARGE' ? 413 : 400, {
            error: errorData(error),
          });
        }
      }
    },
  });
}
