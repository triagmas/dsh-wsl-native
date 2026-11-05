/**
 * Security regression tests for the three findings closed in this change.
 *
 * SEC-01 Full Access expiry, SEC-02 permission escalation, SEC-03 path
 * validation. Every filesystem fixture is created under `mkdtemp` and removed
 * file-by-file; nothing outside the temporary directory is touched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FULL_ACCESS_PHRASE,
  MAX_MODE_LIFETIME_MS,
  PermissionPolicy,
  assertNoPolicyArguments,
  createUserSurfaceAuthority,
  parsePermissionState,
} from '../src/permissions/index.js';
import { classifyPath, homeSecretRoots, type PathGuardContext } from '../src/permissions/paths.js';
import { BridgeError } from '../src/errors.js';

const HOUR = 60 * 60 * 1000;
/** POSIX-only fixtures: symlinks, mount points and WSL realpath resolution. */
const posix = process.platform !== 'win32';
const surface = () => createUserSurfaceAuthority({ kind: 'control-route', authenticated: true });
const denied = { state: ['/tmp/dsh-wsl-state'], system: ['/etc', '/usr'] };

/** A policy with a controllable clock. */
function clocked(start = 1_700_000_000_000) {
  let now = start;
  const policy = new PermissionPolicy(undefined, { now: () => now });
  return {
    policy,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    set(value: number) {
      now = value;
    },
  };
}

const guard = (mode: PathGuardContext['mode'], resolvable = true, workspace = '/home/user/project'): PathGuardContext => ({
  target: 'wsl',
  mode,
  workspace,
  denied,
  roots: ['/home/user/project'],
  resolvable,
});

// ---------------------------------------------------------------- SEC-01 ----

test('SEC-01 Full Access ends automatically at the 24 hour deadline', () => {
  const { policy, advance } = clocked();
  policy.setMode({ mode: 'full-access', confirm: FULL_ACCESS_PHRASE }, surface());
  assert.equal(policy.mode, 'full-access');
  advance(MAX_MODE_LIFETIME_MS - 1000);
  assert.equal(policy.mode, 'full-access', 'still inside the window');
  advance(2000);
  assert.equal(policy.mode, 'protected', 'returned to Protected after the deadline');
  assert.equal(policy.modeExpiresAt, null);
});

test('SEC-01 the window cannot be requested beyond 24 hours', () => {
  const { policy } = clocked();
  const state = policy.setMode({ mode: 'full-access', confirm: FULL_ACCESS_PHRASE, hours: 500 }, surface());
  assert.equal((state.modeExpiresAt as number) - (state.modeIssuedAt as number), MAX_MODE_LIFETIME_MS);
});

test('SEC-01 the deadline survives a restart and still expires', () => {
  const { policy, now } = clocked();
  const persisted = policy.setMode({ mode: 'full-access', confirm: FULL_ACCESS_PHRASE }, surface());

  const restarted = new PermissionPolicy(persisted, { now: () => now + HOUR });
  assert.equal(restarted.mode, 'full-access', 'restart inside the window keeps Full Access');

  const late = new PermissionPolicy(persisted, { now: () => now + MAX_MODE_LIFETIME_MS + 1 });
  assert.equal(late.mode, 'protected', 'restart after the deadline is Protected');
  assert.deepEqual(parsePermissionState(persisted, now + MAX_MODE_LIFETIME_MS + 1), {
    mode: 'protected',
    modeIssuedAt: null,
    modeExpiresAt: null,
    grants: [],
  });
});

test('SEC-01 a damaged state file narrows permissions, never widens them', () => {
  const now = 1_700_000_000_000;
  const corrupt: unknown[] = [
    { mode: 'full-access' },
    { mode: 'full-access', modeIssuedAt: now, modeExpiresAt: null },
    { mode: 'full-access', modeIssuedAt: now, modeExpiresAt: now + 72 * HOUR },
    { mode: 'full-access', modeIssuedAt: 'x', modeExpiresAt: now + HOUR },
    { mode: 'full-access', modeIssuedAt: now - 30 * HOUR, modeExpiresAt: now + HOUR },
    { mode: 'full-access', modeIssuedAt: now + 10 * HOUR, modeExpiresAt: now + 11 * HOUR },
    { mode: 'root', grants: [{}] },
    'not an object',
    null,
  ];
  for (const value of corrupt) {
    const state = parsePermissionState(value, now);
    assert.equal(state.mode, 'protected', `downgraded: ${JSON.stringify(value)}`);
    assert.equal(state.modeExpiresAt, null);
  }
});

test('SEC-01 a backwards clock jump withdraws Full Access', () => {
  const { policy, advance, set, now } = clocked();
  policy.setMode({ mode: 'full-access', confirm: FULL_ACCESS_PHRASE }, surface());
  advance(HOUR);
  set(now - 10 * 60 * 1000);
  assert.equal(policy.mode, 'protected', 'clock jump is treated as tampering');
  assert.equal(policy.clockTampered, true);
  // The withdrawn window is not resurrected by the clock moving forward again.
  advance(2 * HOUR);
  assert.equal(policy.mode, 'protected');
});

test('SEC-01 an expired window is flagged for persistence', () => {
  const { policy, advance } = clocked();
  policy.setMode({ mode: 'full-access', confirm: FULL_ACCESS_PHRASE }, surface());
  assert.equal(policy.needsPersist, true, 'a mode change must be written');
  policy.markPersisted();
  assert.equal(policy.needsPersist, false);
  advance(MAX_MODE_LIFETIME_MS + 1);
  assert.equal(policy.mode, 'protected');
  const persisted = policy.snapshot();
  assert.equal(persisted.mode, 'protected');
  assert.equal(persisted.modeExpiresAt, null);
  // No resurrection: reloading the persisted state keeps Protected.
  assert.equal(new PermissionPolicy(persisted).mode, 'protected');
});

// ---------------------------------------------------------------- SEC-02 ----

test('SEC-02 a flag is not authority: userInitiated cannot change the mode', () => {
  const policy = new PermissionPolicy();
  const forged = { mode: 'full-access', confirm: FULL_ACCESS_PHRASE, userInitiated: true } as const;
  // The authority type is structural, so only the runtime WeakSet decides:
  // a look-alike object is rejected exactly like a missing one.
  assert.throws(
    () => policy.setMode(forged, { surface: 'control-route' }),
    (error: unknown) => error instanceof BridgeError && error.code === 'PERMISSION_DENIED',
  );
  // @ts-expect-error a missing authority fails to compile and at runtime.
  assert.throws(() => policy.setMode(forged));
  assert.equal(policy.mode, 'protected');
});

test('SEC-02 an authority cannot be minted without user-surface evidence', () => {
  for (const evidence of [
    { kind: 'interactive-cli', tty: false },
    { kind: 'control-route', authenticated: false },
  ] as const) {
    assert.throws(
      () => createUserSurfaceAuthority(evidence),
      (error: unknown) => error instanceof BridgeError && error.code === 'PERMISSION_DENIED',
    );
  }
  assert.doesNotThrow(() => createUserSurfaceAuthority({ kind: 'interactive-cli', tty: true }));
});

test('SEC-02 tool arguments cannot carry authority or policy fields', () => {
  for (const key of ['mode', 'permissions', 'grant', 'userInitiated', 'confirm', 'authority', 'hours']) {
    assert.throws(
      () => assertNoPolicyArguments({ command: 'true', [key]: 'x' }),
      (error: unknown) => error instanceof BridgeError && error.code === 'INVALID_ARGUMENT',
      key,
    );
  }
});

test('SEC-02 the CLI refuses policy changes without an interactive terminal', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-cli-'));
  const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
  try {
    const result = await runCli(cli, home, [
      'permissions',
      '--mode',
      'full-access',
      '--confirm',
      FULL_ACCESS_PHRASE,
    ]);
    assert.notEqual(result.code, 0, 'a tool-spawned CLI must not escalate');
    assert.match(result.stderr + result.stdout, /DENIED|PERMISSION|terminal|терминал|终端/i);
    const settingsFile = path.join(home, 'dsh-wsl-native', 'settings.json');
    const written = await fs.readFile(settingsFile, 'utf8').catch(() => null);
    if (written !== null) {
      assert.equal(JSON.parse(written).permissions?.mode ?? 'protected', 'protected');
    }
  } finally {
    await fs.unlink(path.join(home, 'dsh-wsl-native', 'settings.json')).catch(() => {});
    await fs.rmdir(path.join(home, 'dsh-wsl-native')).catch(() => {});
    await fs.rmdir(home).catch(() => {});
  }
});

test('SEC-02 a hand-edited settings file cannot open a Full Access window', () => {
  const now = Date.now();
  const edited = {
    mode: 'full-access',
    grants: [{ id: 'granted', capability: 'exec', target: 'wsl', root: null, createdAt: now, expiresAt: null }],
  };
  const policy = new PermissionPolicy(edited);
  assert.equal(policy.mode, 'protected');
  // A grants array still loads, but it can never be used to bypass approvals in
  // Protected mode because grants are only consulted in Trusted mode.
  for (const grant of policy.grants) assert.equal(grant.capability, 'exec');
});

// ---------------------------------------------------------------- SEC-03 ----

test('SEC-03 a symlink that leaves the workspace is denied', { skip: !posix }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-paths-'));
  const workspace = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  const link = path.join(workspace, 'escape');
  try {
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.symlink(outside, link, 'dir');
    const verdict = await classifyPath(path.join(link, 'file.txt'), {
      ...guard('protected'),
      workspace,
      roots: [workspace],
    });
    assert.deepEqual(verdict, { kind: 'deny', code: 'SYMLINK_ESCAPE' });
    // The same path through its real location is still just outside, not denied.
    const plain = await classifyPath(path.join(outside, 'file.txt'), {
      ...guard('protected'),
      workspace,
      roots: [workspace],
    });
    assert.equal(plain.kind, 'outside');
  } finally {
    await fs.unlink(link).catch(() => {});
    await fs.rmdir(outside).catch(() => {});
    await fs.rmdir(workspace).catch(() => {});
    await fs.rmdir(root).catch(() => {});
  }
});

test('SEC-03 UNC shares and device paths are hard denials', async () => {
  assert.deepEqual(await classifyPath('\\\\server\\share\\file.txt', guard('full-access')), {
    kind: 'deny',
    code: 'UNC_PATH',
  });
  assert.deepEqual(await classifyPath('\\\\?\\C:\\Users\\file.txt', guard('full-access')), {
    kind: 'deny',
    code: 'DEVICE_PATH',
  });
});

test('SEC-03 mounted Windows drives are never auto-approved outside Full Access', { skip: !posix }, async () => {
  const verdict = await classifyPath('/mnt/c/Users/me/file.txt', guard('protected', true, '/mnt/c/Users/me'));
  assert.deepEqual(verdict, { kind: 'outside', code: 'MOUNTED_DRIVE' });
  assert.equal((await classifyPath('/mnt/c/Users/me/file.txt', guard('full-access', true, '/mnt/c/Users/me'))).kind, 'allow');
});

test('SEC-03 jumping between filesystems needs approval', { skip: !posix }, async () => {
  const verdict = await classifyPath('/home/user/project/file.txt', guard('protected', true, '/mnt/c/work'));
  assert.deepEqual(verdict, { kind: 'outside', code: 'CROSS_FILESYSTEM' });
});

test('SEC-03 empty, relative and oversized paths are refused', async () => {
  for (const value of ['', '   ', 'relative/file.txt', `/${'a'.repeat(5000)}`]) {
    assert.deepEqual(await classifyPath(value, guard('protected')), { kind: 'deny', code: 'INVALID_PATH' }, value);
  }
});

test('SEC-03 a path the host cannot resolve is never auto-approved, even in Full Access', async () => {
  // The other system's paths: WSL paths from a Windows host and Windows paths
  // from a Linux host are exactly the case this rule exists for.
  const foreign =
    process.platform === 'win32'
      ? ({ capability: 'write', target: 'wsl', path: '/home/user/file.txt' } as const)
      : ({ capability: 'write', target: 'windows', path: 'C:\\work\\file.txt' } as const);
  const policy = new PermissionPolicy();
  policy.setMode({ mode: 'full-access', confirm: FULL_ACCESS_PHRASE }, surface());
  const decision = await policy.evaluate(foreign, { workspace: null, denied, roots: [] });
  assert.equal(decision.kind, 'ask', 'unverifiable cross-system write needs approval');
});

test('SEC-03 grants never authorize a mounted drive without verification', async () => {
  const policy = new PermissionPolicy();
  policy.setMode({ mode: 'trusted' }, surface());
  policy.addGrant({ capability: 'write', target: 'wsl', root: '/mnt/c/work', hours: 1 });
  const decision = await policy.evaluate(
    { capability: 'write', target: 'wsl', path: '/mnt/c/work/file.txt' },
    { workspace: '/mnt/c/work', denied, roots: [] },
  );
  assert.equal(decision.kind, 'ask', 'mounted drive keeps asking even with a matching grant');
});

test('SEC-03 HOME and USERPROFILE secret roots are derived from the process environment', () => {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = '/home/example';
  process.env.USERPROFILE = 'C:\\Users\\example';
  try {
    const wsl = homeSecretRoots('wsl');
    assert.ok(wsl.includes('/home/example/.ssh'), wsl.join(','));
    assert.ok(wsl.includes('/home/example/.dsh'));
    for (const root of wsl) assert.ok(path.posix.isAbsolute(root), root);
    const windows = homeSecretRoots('windows');
    assert.ok(windows.some((root) => root.toLowerCase().startsWith('c:\\users\\example')), windows.join(','));
    for (const root of windows) assert.ok(path.win32.isAbsolute(root), root);
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.USERPROFILE;
  }
});

// --------------------------------------------------------------- helpers ----

/** Run the CLI with a piped stdio, exactly like a tool-spawned process. */
function runCli(cli: string, home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: home, DSH_WSL_NATIVE_LOCALE: 'en' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end();
  });
}
