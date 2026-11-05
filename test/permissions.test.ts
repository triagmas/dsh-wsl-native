import assert from 'node:assert/strict';
import test from 'node:test';
import { FULL_ACCESS_PHRASE, PermissionPolicy, assertNoPolicyArguments, parsePermissionState } from '../src/permissions/index.js';
import { classifyPath, isInside, type PathGuardContext } from '../src/permissions/paths.js';
import { BridgeError } from '../src/errors.js';

const denied = {
  state: ['/home/user/.dsh/dsh-wsl-native/settings.json', '/home/user/.ssh'],
  system: ['/etc', '/usr', '/boot'],
};

const environment = (mode: 'protected' | 'trusted' | 'full-access' = 'protected'): PathGuardContext => ({
  target: 'wsl',
  mode,
  workspace: '/home/user/project',
  denied,
  roots: [],
  resolvable: false,
});

test('a fresh policy starts in Protected mode', () => {
  const policy = new PermissionPolicy(undefined);
  assert.equal(policy.mode, 'protected');
  assert.deepEqual(policy.grants, []);
});

test('an unreadable state file falls back to Protected', () => {
  assert.equal(parsePermissionState({ mode: 'open', grants: [{ id: 1 }] }).mode, 'protected');
  assert.deepEqual(parsePermissionState({ mode: 'trusted', grants: [{ id: 1 }] }).grants, []);
});

test('agents cannot switch the mode or widen their own rights', () => {
  const policy = new PermissionPolicy();
  assert.throws(
    () => policy.setMode({ mode: 'full-access', userInitiated: false, confirm: FULL_ACCESS_PHRASE }),
    (error: unknown) => error instanceof BridgeError && error.code === 'PERMISSION_DENIED',
  );
  assert.equal(policy.mode, 'protected');
});

test('Full Access needs the exact confirmation phrase', () => {
  const policy = new PermissionPolicy();
  assert.throws(() => policy.setMode({ mode: 'full-access', userInitiated: true, confirm: 'full access' }));
  assert.equal(policy.mode, 'protected');
  assert.equal(policy.setMode({ mode: 'full-access', userInitiated: true, confirm: FULL_ACCESS_PHRASE }).mode, 'full-access');
});

test('tool arguments cannot smuggle policy fields', () => {
  assert.doesNotThrow(() => assertNoPolicyArguments({ command: 'uname -a', target: 'wsl' }));
  for (const key of ['mode', 'permissionMode', 'grant', 'grants', 'permissions', 'userInitiated', 'confirm']) {
    assert.throws(() => assertNoPolicyArguments({ command: 'x', [key]: 'full-access' }), BridgeError, key);
  }
});

test('grants are clamped to 24 hours and reject pathless capabilities with a root', () => {
  const policy = new PermissionPolicy();
  const grant = policy.addGrant({ capability: 'exec', target: 'wsl', hours: 500 });
  const lifetime = (grant.expiresAt ?? 0) - grant.createdAt;
  assert.equal(lifetime, 24 * 60 * 60 * 1000);
  assert.throws(() => policy.addGrant({ capability: 'exec', target: 'wsl', root: '/home/user', hours: 1 }));
  assert.throws(() => policy.addGrant({ capability: 'write', target: 'wsl', root: 'relative', hours: 1 }));
});

test('grants can be revoked and expire', () => {
  const policy = new PermissionPolicy();
  const grant = policy.addGrant({ capability: 'write', target: 'wsl', root: '/home/user/project', hours: 1 });
  assert.equal(policy.revoke(grant.id), true);
  assert.equal(policy.revoke(grant.id), false);
  const expired = new PermissionPolicy({
    mode: 'trusted',
    grants: [{ ...grant, expiresAt: Date.now() - 1000 }],
  });
  assert.deepEqual(expired.grants, []);
});

test('path classification denies state and system locations', async () => {
  const state = await classifyPath('/home/user/.dsh/dsh-wsl-native/settings.json', environment());
  assert.deepEqual(state, { kind: 'deny', code: 'STATE_FILE' });
  const system = await classifyPath('/etc/passwd', environment());
  assert.deepEqual(system, { kind: 'deny', code: 'SYSTEM_PATH' });
  const full = await classifyPath('/etc/passwd', environment('full-access'));
  assert.equal(full.kind, 'allow');
  const outside = await classifyPath('/etc/passwd', environment('trusted'));
  assert.deepEqual(outside, { kind: 'deny', code: 'SYSTEM_PATH' });
});

test('workspace content is allowed and unrelated paths need approval', async () => {
  assert.equal((await classifyPath('/home/user/project/src/index.ts', environment())).kind, 'allow');
  assert.equal((await classifyPath('/home/user/other/file.txt', environment())).kind, 'outside');
  assert.equal((await classifyPath('/home/user/other/file.txt', environment('full-access'))).kind, 'allow');
});

test('relative paths are refused outright', async () => {
  assert.deepEqual(await classifyPath('relative/path', environment()), { kind: 'deny', code: 'INVALID_PATH' });
});

test('isInside respects Windows case folding and separators', () => {
  assert.equal(isInside('C:\\Work', 'c:\\work\\file.txt', 'windows'), true);
  assert.equal(isInside('/home/user', '/home/user2/file', 'wsl'), false);
  assert.equal(isInside('/home/user', '/home/user', 'wsl'), true);
});

test('the default decision is to ask, never to run unapproved', async () => {
  const policy = new PermissionPolicy();
  const decision = await policy.evaluate(
    { capability: 'exec', target: 'wsl', workspace: '/home/user/project' },
    { workspace: '/home/user/project', denied, roots: [] },
  );
  assert.equal(decision.kind, 'ask');
});

test('a matching grant allows the operation while the mode stays Protected', async () => {
  const policy = new PermissionPolicy();
  policy.setMode({ mode: 'trusted', userInitiated: true });
  policy.addGrant({ capability: 'write', target: 'wsl', root: '/home/user/project', hours: 2 });
  const decision = await policy.evaluate(
    { capability: 'write', target: 'wsl', path: '/home/user/project/file.txt', workspace: '/home/user/project' },
    { workspace: '/home/user/project', denied, roots: [] },
  );
  assert.equal(decision.kind, 'allow');
});

test('a grant never authorizes a denied path', async () => {
  const policy = new PermissionPolicy();
  policy.setMode({ mode: 'trusted', userInitiated: true });
  policy.addGrant({ capability: 'write', target: 'wsl', root: '/home/user', hours: 2 });
  const decision = await policy.evaluate(
    { capability: 'write', target: 'wsl', path: '/home/user/.ssh/authorized_keys', workspace: '/home/user/project' },
    { workspace: '/home/user/project', denied, roots: [] },
  );
  assert.equal(decision.kind, 'deny');
});
