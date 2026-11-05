import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WslService } from './service.js';
import { NativeLauncher } from './launcher.js';
import { BridgeError, ensure, errorData, isErrorWithCode } from './errors.js';
import { isLocale, setLocale, t } from './i18n/index.js';
import {
  FULL_ACCESS_PHRASE,
  PERMISSION_MODES,
  createUserSurfaceAuthority,
} from './permissions/index.js';
import type { PermissionGrant, PermissionMode, PolicyAuthority } from './permissions/types.js';
import type { JobStatusResult } from './worker-protocol.js';

/**
 * Authority for policy mutations on the command line.
 *
 * The CLI is only a user surface when a human is typing into a terminal. A
 * tool-spawned child process (the agent's `exec`) has no controlling terminal,
 * so `dsh-wsl permissions` and `dsh-wsl grant` refuse to run there instead of
 * letting the agent widen its own permissions.
 */
function authority(): PolicyAuthority {
  return createUserSurfaceAuthority({
    kind: 'interactive-cli',
    tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
}

/** Command-line surface for the plugin, also used for manual verification. */
const COMMANDS = [
  'list',
  'status',
  'doctor',
  'exec',
  'path',
  'setup',
  'start',
  'permissions',
  'grant',
  'revoke',
  'help',
] as const;

/** Run one CLI invocation and resolve when it has finished. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let service: WslService | undefined;
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        distro: { type: 'string' },
        user: { type: 'string' },
        cwd: { type: 'string' },
        port: { type: 'string' },
        command: { type: 'string' },
        target: { type: 'string' },
        path: { type: 'string' },
        direction: { type: 'string' },
        timeout: { type: 'string' },
        'linux-node': { type: 'string' },
        'windows-node': { type: 'string' },
        json: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        'install-network': { type: 'string' },
        'npm-cache': { type: 'string' },
        reinstall: { type: 'boolean' },
        locale: { type: 'string' },
        mode: { type: 'string' },
        confirm: { type: 'string' },
        capability: { type: 'string' },
        root: { type: 'string' },
        hours: { type: 'string' },
        id: { type: 'string' },
      },
    });
    if (values.locale !== undefined) {
      ensure(isLocale(values.locale), 'INVALID_ARGUMENT', 'errors.forbiddenValue', { name: 'locale' });
      setLocale(values.locale);
    }
    const command = positionals[0];
    if (values.help || !command || command === 'help') {
      console.log(t('cli.help', { version: (await import('./service.js')).PLUGIN_VERSION }));
      return;
    }
    ensure((COMMANDS as readonly string[]).includes(command), 'INVALID_ARGUMENT', 'cli.unknownCommand', {
      command,
    });
    ensure(positionals.length === 1, 'INVALID_ARGUMENT', 'cli.extraArguments');
    service = new WslService({
      distro: values.distro,
      user: values.user,
      linuxNode: values['linux-node'],
      windowsNode: values['windows-node'],
    });
    await service.initialized;
    const options = { distro: values.distro, user: values.user, signal: controller.signal };
    let result: unknown;
    if (command === 'list') {
      result = await service.distros(true);
    } else if (command === 'status') {
      result = await service.status();
    } else if (command === 'doctor') {
      const checks: unknown[] = [];
      for (const target of ['wsl', 'windows'] as const) {
        try {
          checks.push({ target, ok: true, ...(await service.ping(target, options)) });
        } catch (error) {
          checks.push({ target, ok: false, ...errorData(error) });
        }
      }
      result = { checks, ok: checks.every((item) => (item as { ok: boolean }).ok) };
      if (!(result as { ok: boolean }).ok) process.exitCode = 1;
    } else if (command === 'exec') {
      ensure(typeof values.command === 'string', 'INVALID_ARGUMENT', 'errors.text', { name: 'command' });
      result = await service.execute(
        values.target === 'windows' ? 'windows' : 'wsl',
        {
          command: values.command,
          cwd: values.cwd,
          timeoutMs: values.timeout ? Number(values.timeout) : undefined,
        },
        options,
      );
      const process_ = result as { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; cancelled: boolean };
      if (!values.json) {
        process.stdout.write(process_.stdout);
        process.stderr.write(process_.stderr);
      }
      process.exitCode = process_.timedOut ? 124 : process_.cancelled ? 130 : (process_.exitCode ?? 1);
      if (!values.json) return;
    } else if (command === 'path') {
      ensure(typeof values.path === 'string', 'INVALID_ARGUMENT', 'errors.text', { name: 'path' });
      result = await service.convert(
        values.path,
        values.direction === 'windows' ? 'windows' : 'linux',
        options,
      );
    } else if (command === 'setup') {
      const launcher = new NativeLauncher(service);
      let phase: string | undefined;
      result = await launcher.prepare({
        ...options,
        installNetwork:
          values['install-network'] === 'windows' || values['install-network'] === 'linux'
            ? values['install-network']
            : 'auto',
        npmCache: values['npm-cache'],
        reinstall: values.reinstall === true,
        onProgress: (progress) => {
          if (!values.json && phase !== progress.text) {
            phase = progress.text;
            process.stderr.write(progress.text + '\n');
          }
        },
      });
    } else if (command === 'start') {
      const launcher = new NativeLauncher(service);
      result = await launcher.start({
        ...options,
        cwd: values.cwd,
        port: values.port ? Number(values.port) : 0,
      });
      const running = result as { url: string; id: string; distro: string };
      console.log(
        values.json ? JSON.stringify(running) : t('cli.started', { url: running.url }),
      );
      if (!values['no-open']) {
        await service.windows({ action: 'open', target: running.url }, options);
      }
      while (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1500);
          function done(): void {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', done);
            resolve();
          }
          controller.signal.addEventListener('abort', done, { once: true });
        });
        if (controller.signal.aborted) break;
        const job = (await service.job(
          'wsl',
          'status',
          { id: running.id },
          { distro: running.distro },
        )) as JobStatusResult;
        ensure(job.status === 'running', 'DSH_STOPPED', 'cli.stopped', { status: job.status, stderr: job.stderr });
      }
      await launcher.stop();
      return;
    } else if (command === 'permissions') {
      if (values.mode !== undefined) {
        ensure(
          (PERMISSION_MODES as readonly string[]).includes(values.mode),
          'INVALID_ARGUMENT',
          'errors.forbiddenValue',
          { name: 'mode' },
        );
        result = await service.setPermissionMode(
          { mode: values.mode, confirm: values.confirm },
          authority(),
        );
      } else {
        result = service.permissions.snapshot();
      }
      if (!values.json) {
        const state = result as { mode: PermissionMode; grants: PermissionGrant[] };
        console.log(t('cli.permissionMode', { mode: state.mode }));
        if (!state.grants.length) console.log(t('cli.noGrants'));
        for (const grant of state.grants) {
          console.log(
            t('cli.grantLine', {
              capability: grant.capability,
              target: grant.target,
              root: grant.root ?? '*',
              expiry: grant.expiresAt === null ? t('ui.permissions.neverExpires') : new Date(grant.expiresAt).toISOString(),
            }),
          );
        }
        return;
      }
    } else if (command === 'grant' || command === 'revoke') {
      if (command === 'revoke') {
        ensure(typeof values.id === 'string', 'INVALID_ARGUMENT', 'errors.forbiddenValue', { name: 'id' });
        result = await service.revokePermissionGrant(values.id, authority());
      } else {
        const hours = values.hours === undefined ? undefined : Number(values.hours);
        const grant = await service.addPermissionGrant(
          {
            capability: values.capability,
            target: values.target,
            root: values.root,
            hours,
          },
          authority(),
        );
        result = grant;
        if (!values.json) {
          console.log(t('cli.grantAdded', { id: grant.id }));
          return;
        }
      }
    }
    if (command === 'permissions' && values.mode !== undefined && !values.json) {
      const state = result as { mode: PermissionMode };
      console.log(t('ui.permissions.modeChanged', { mode: state.mode }));
      return;
    }
    if (command === 'revoke' && !values.json) {
      console.log(t('cli.grantRevoked'));
      return;
    }
    console.log(JSON.stringify(result, null, values.json ? 0 : 2));
  } catch (error) {
    const code = isErrorWithCode(error) ? error.code : 'ERROR';
    console.error(`${code}: ${(error as Error).message}`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    await service?.close();
  }
}

/** Report the destructive confirmation phrase in one place for tests. */
export const FULL_ACCESS_CONFIRMATION = FULL_ACCESS_PHRASE;

export { BridgeError };

// Only run when executed directly (`dsh-wsl`, `node dist/cli.js`); tests import
// `main` and must not start a process-level parse.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
