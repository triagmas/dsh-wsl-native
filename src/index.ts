import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ParameterPropertySpec, ToolDefinition } from '@deepseek-ai/dsh-tools';
import { WslService, type CallOptions, type FileArgs, type WslConfig } from './service.js';
import { authorize, type PolicyContext, type ToolExec } from './policy.js';
import { createController, registerControlRoutes, registerRoutes, type ConnectionLike, type WebServerLike } from './routes.js';
import { BridgeError, ensure } from './errors.js';
import { assertNoPolicyArguments } from './permissions/index.js';
import type { Capability, GrantTarget, PermissionDecision, PermissionRequest } from './permissions/types.js';
import { t } from './i18n/index.js';

export const name = 'dsh-wsl-native';
export const inject = ['tools'];

/** Minimal structural view of the Cordis context this plugin uses. */
interface PluginContext extends PolicyContext {
  tools: { register(tool: ToolDefinition): () => void };
  effect(setup: () => unknown): void;
  inject(deps: string[], callback: (ctx: PluginContext & CarrierContext) => void): void;
  get(name: string): unknown;
}

/** Services provided by the carriers the plugin injects. */
interface CarrierContext {
  connection?: ConnectionLike;
  webServer?: WebServerLike;
}

/** Panel profile injected by the Desktop host. */
interface ProfileContext {
  home: string;
  dir: string;
  name: string;
}

/**
 * One text parameter. The literal object shape is preserved with `satisfies`
 * so the Harness can still infer precise argument types for `execute`.
 */
interface TextParameter {
  type: 'string';
  description: string;
}

interface RequiredTextParameter extends TextParameter {
  required: true;
}

function str(description: string): TextParameter;
function str(description: string, required: true): RequiredTextParameter;
function str(description: string, required = false): TextParameter | RequiredTextParameter {
  return required ? { type: 'string', description, required: true } : { type: 'string', description };
}

const target = {
  type: 'string',
  enum: ['wsl', 'windows'],
  description: t('tools.param.target'),
} satisfies ParameterPropertySpec;

const distro = str(t('tools.param.distro'));
const user = str(t('tools.param.user'));

/** Lossless JSON value accepted by the Harness output contract. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Project one result onto the canonical lossless-JSON output contract. */
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json;

const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ],
};

/** Resolve proxy options from validated tool arguments. */
function options(args: { distro?: string; user?: string }, exec: ToolExec): CallOptions {
  return { distro: args.distro, user: args.user, signal: exec.signal };
}

/**
 * Apply the permission policy to one tool call.
 *
 * The mode and the grants are owned by the user: they arrive from the settings
 * file, never from model arguments. A denied operation is refused before any
 * connection is opened, and an operation that needs approval goes through
 * DSH's own approval service, which fails closed when it is unavailable.
 */
async function guard(
  ctx: PolicyContext,
  exec: ToolExec,
  service: WslService,
  request: PermissionRequest,
): Promise<void> {
  const decision: PermissionDecision = await service.permissions.evaluate(request, service.guardEnvironment());
  if (decision.kind === 'deny') throw new BridgeError(decision.code, decision.reason);
  if (decision.kind === 'allow') return;
  await authorize(ctx, exec, decision.reason);
}

/** Register the seven bridge tools and both carriers. */
export function apply(ctx: PluginContext, config: WslConfig = {}): void {
  const profile = ctx.get('profileContext') as ProfileContext | undefined;
  const service = new WslService({
    ...config,
    sourceProfile:
      config.sourceProfile ?? (profile ? { home: profile.home, dir: profile.dir, name: profile.name } : undefined),
  });
  ctx.effect(() => () => service.close());
  ctx.tools.register(defineTool({
    output,
    name: 'wsl_native_status',
    description: t('tools.status.description'),
    parameters: {},
    isConcurrencySafe: () => true,
    execute: async () => json(await service.status()),
  }));
  ctx.tools.register(defineTool({
    output,
    name: 'wsl_native_exec',
    description: t('tools.exec.description'),
    parameters: {
      target,
      distro,
      user,
      command: str(t('tools.param.command')),
      executable: str(t('tools.param.executable')),
      args: {
        type: 'array',
        items: { type: 'string' as const },
        description: t('tools.param.args'),
      },
      cwd: str(t('tools.param.cwd')),
      env: { type: 'json', description: t('tools.param.env') },
      timeoutMs: {
        type: 'integer',
        description: t('tools.param.timeoutMs'),
      },
    },
    async execute(args, exec) {
      assertNoPolicyArguments(args as Record<string, unknown>);
      ensure(
        args.timeoutMs === undefined || args.timeoutMs <= 600000,
        'INVALID_ARGUMENT',
        'tools.error.execTimeoutLimit',
      );
      const resolved = args.target === 'windows' ? 'windows' : 'wsl';
      await guard(ctx, exec, service, {
        capability: 'exec',
        target: resolved,
        workspace: service.settings.directory || null,
      });
      return json(await service.execute(
        resolved,
        {
          command: args.command,
          executable: args.executable,
          args: args.args,
          cwd: args.cwd,
          env: args.env as Record<string, string> | undefined,
          timeoutMs: args.timeoutMs,
        },
        options(args, exec),
      ));
    },
  }));
  ctx.tools.register(defineTool({
    output,
    name: 'wsl_native_files',
    description: t('tools.files.description'),
    parameters: {
      target,
      distro,
      user,
      operation: {
        type: 'string',
        enum: ['list', 'read', 'write', 'stat'],
        required: true,
      },
      path: str(t('tools.param.path'), true),
      content: str(t('tools.param.content')),
      expectedHash: str(t('tools.param.expectedHash')),
      encoding: { type: 'string', enum: ['utf8', 'gb18030', 'base64'] },
      offset: { type: 'integer', description: t('tools.param.offset') },
      limit: { type: 'integer', description: t('tools.param.limit') },
      hidden: { type: 'boolean', description: t('tools.param.hidden') },
      hash: { type: 'boolean', description: t('tools.param.hash') },
    },
    isConcurrencySafe: (args) => args.operation !== 'write',
    async execute(args, exec) {
      assertNoPolicyArguments(args as Record<string, unknown>);
      const resolved = (args.target === 'windows' ? 'windows' : 'wsl') as GrantTarget;
      if (args.operation === 'write') {
        await guard(ctx, exec, service, {
          capability: 'write',
          target: resolved,
          path: args.path,
          workspace: service.settings.directory || null,
        });
      }
      const input: FileArgs = {
        path: args.path,
        content: args.content,
        expectedHash: args.expectedHash,
        encoding: args.encoding,
        offset: args.offset,
        limit: args.limit,
        hidden: args.hidden,
        hash: args.hash,
      };
      return json(await service.files(resolved, args.operation, input, options(args, exec)));
    },
  }));
  ctx.tools.register(defineTool({
    output,
    name: 'wsl_native_copy',
    description: t('tools.copy.description'),
    parameters: {
      from: { ...target, required: true },
      to: { ...target, required: true },
      distro,
      user,
      source: str(t('tools.param.source'), true),
      destination: str(t('tools.param.destination'), true),
      expectedHash: str(t('tools.param.expectedHash')),
    },
    async execute(args, exec) {
      assertNoPolicyArguments(args as Record<string, unknown>);
      const to = (args.to === 'windows' ? 'windows' : 'wsl') as GrantTarget;
      await guard(ctx, exec, service, {
        capability: 'copy',
        target: to,
        path: args.destination,
        paths: [args.source, args.destination],
        workspace: service.settings.directory || null,
      });
      return json(await service.copy({
        from: args.from === 'windows' ? 'windows' : 'wsl',
        to,
        source: args.source,
        destination: args.destination,
        expectedHash: args.expectedHash,
        distro: args.distro,
        user: args.user,
        signal: exec.signal,
      }));
    },
  }));
  ctx.tools.register(defineTool({
    output,
    name: 'wsl_native_path',
    description: t('tools.path.description'),
    parameters: {
      path: str(t('tools.param.path'), true),
      direction: { type: 'string', enum: ['linux', 'windows'], required: true },
      distro,
      user,
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => json(await service.convert(args.path, args.direction, options(args, exec))),
  }));
  ctx.tools.register(defineTool({
    output,
    name: 'wsl_native_windows',
    description: t('tools.windows.description'),
    parameters: {
      action: {
        type: 'string',
        enum: ['open', 'clipboard_get', 'clipboard_set'],
        required: true,
      },
      target: str(t('tools.param.text')),
      text: str(t('tools.param.text')),
      distro,
      user,
    },
    async execute(args, exec) {
      assertNoPolicyArguments(args as Record<string, unknown>);
      await guard(ctx, exec, service, {
        capability: 'windows',
        target: 'windows',
        action: args.action,
        workspace: service.settings.directory || null,
      });
      return json(
        await service.windows({ action: args.action, target: args.target, text: args.text }, options(args, exec)),
      );
    },
  }));
  ctx.tools.register(defineTool({
    output,
    name: 'wsl_native_job',
    description: t('tools.job.description'),
    parameters: {
      action: {
        type: 'string',
        enum: ['start', 'status', 'cancel', 'forget'],
        required: true,
      },
      target,
      distro,
      user,
      id: str(t('tools.param.jobId')),
      command: str(t('tools.param.command')),
      cwd: str(t('tools.param.cwd')),
      timeoutMs: { type: 'integer', description: t('tools.param.jobTimeout') },
    },
    async execute(args, exec) {
      assertNoPolicyArguments(args as Record<string, unknown>);
      ensure(
        args.timeoutMs === undefined || args.timeoutMs > 0,
        'INVALID_ARGUMENT',
        'tools.error.jobTimeoutPositive',
      );
      const resolved = (args.target === 'windows' ? 'windows' : 'wsl') as GrantTarget;
      if (args.action !== 'status') {
        await guard(ctx, exec, service, {
          capability: 'job' as Capability,
          target: resolved,
          action: args.action,
          workspace: service.settings.directory || null,
        });
      }
      return json(
        await service.job(
          resolved,
          args.action,
          { id: args.id, command: args.command, cwd: args.cwd, timeoutMs: args.timeoutMs },
          options(args, exec),
        ),
      );
    },
  }));
  const controller = createController(service);
  ctx.effect(() => () => controller.close());
  ctx.inject(['connection'], (controlCtx) => {
    controlCtx.effect(() => {
      void registerControlRoutes(controlCtx.connection as ConnectionLike, controller);
    });
  });
  ctx.inject(['webServer', 'connection'], (routeCtx) => {
    routeCtx.effect(() =>
      registerRoutes(routeCtx.webServer as WebServerLike, service, routeCtx.connection, controller),
    );
  });
}
