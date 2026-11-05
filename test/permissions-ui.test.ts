/**
 * Regression tests for the two panel forms fixed in R03.1.
 *
 * The forms are pure payload builders, so they are tested without a DOM: the
 * panel renders exactly what `buildModeRequest` and `buildGrantRequest` return,
 * and the host validates that same payload in `PermissionPolicy`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FULL_ACCESS_MINUTES,
  GRANT_CAPABILITIES,
  GRANT_HOURS,
  GRANT_TARGETS,
  buildGrantRequest,
  buildModeRequest,
  minutesLabelKey,
  minutesLabelParams,
  needsRoot,
} from '../src/permissions-form.js';
import { FULL_ACCESS_PHRASE as HOST_PHRASE, PermissionPolicy, createUserSurfaceAuthority } from '../src/permissions/index.js';
import { FULL_ACCESS_PHRASE } from '../src/permissions/phrase.js';
import { en } from '../src/i18n/en.js';
import { ru } from '../src/i18n/ru.js';
import { zhCN } from '../src/i18n/zh-CN.js';
import type { GuardEnvironment } from '../src/permissions/index.js';

const HOUR = 60 * 60 * 1000;
const surface = (): ReturnType<typeof createUserSurfaceAuthority> =>
  createUserSurfaceAuthority({ kind: 'control-route', authenticated: true });

/** Policy with a controllable clock, mirroring how the host runs it. */
function clocked(start = 1_700_000_000_000) {
  let now = start;
  const policy = new PermissionPolicy(undefined, { now: () => now });
  return {
    policy,
    advance(ms: number) {
      now += ms;
    },
  };
}

const environment: GuardEnvironment = {
  denied: { state: ['/tmp/dsh-wsl-state'], system: ['/etc', '/usr'] },
  roots: ['/home/user/project'],
  workspace: '/home/user/project',
};

// ------------------------------------------------------- Full Access form ----

test('the panel and the host agree on the confirmation phrase', () => {
  assert.equal(FULL_ACCESS_PHRASE, HOST_PHRASE);
  assert.equal(FULL_ACCESS_PHRASE, 'FULL ACCESS');
});

test('Protected and Trusted need no confirmation and no lifetime', () => {
  for (const mode of ['protected', 'trusted'] as const) {
    const built = buildModeRequest(mode, '', 60);
    assert.ok(built.ok);
    assert.deepEqual(built.value, { mode });
    assert.equal('confirm' in built.value, false);
    assert.equal('hours' in built.value, false);
  }
});

test('Full Access refuses a missing, wrong-case or padded phrase', () => {
  for (const phrase of ['', 'full access', 'FULL ACCESS ', 'FULLACCESS', 'FULL  ACCESS']) {
    const built = buildModeRequest('full-access', phrase, 60);
    assert.equal(built.ok, false);
    if (!built.ok) assert.equal(built.error, 'ui.permissions.confirmRequired');
  }
});

test('Full Access converts the chosen minutes into hours', () => {
  const built = buildModeRequest('full-access', FULL_ACCESS_PHRASE, 60);
  assert.ok(built.ok);
  assert.deepEqual(built.value, { mode: 'full-access', confirm: FULL_ACCESS_PHRASE, hours: 1 });

  const short = buildModeRequest('full-access', FULL_ACCESS_PHRASE, 1);
  assert.ok(short.ok);
  assert.equal(short.value.hours, 1 / 60);

  const long = buildModeRequest('full-access', FULL_ACCESS_PHRASE, 240);
  assert.ok(long.ok);
  assert.equal(long.value.hours, 4);
});

test('Full Access minutes are clamped to the host window', () => {
  const low = buildModeRequest('full-access', FULL_ACCESS_PHRASE, 0);
  assert.ok(low.ok);
  assert.equal(low.value.hours, 1 / 60);

  const high = buildModeRequest('full-access', FULL_ACCESS_PHRASE, 5000);
  assert.ok(high.ok);
  assert.equal(high.value.hours, 24);

  const fractional = buildModeRequest('full-access', FULL_ACCESS_PHRASE, 7.6);
  assert.ok(fractional.ok);
  assert.equal(fractional.value.hours, 8 / 60);
});

test('every offered duration renders a label present in all locales', () => {
  for (const minutes of FULL_ACCESS_MINUTES) {
    const key = minutesLabelKey(minutes);
    assert.ok(key in en, `en is missing ${key}`);
    assert.ok(key in ru, `ru is missing ${key}`);
    assert.ok(key in zhCN, `zh-CN is missing ${key}`);
    const params = minutesLabelParams(minutes);
    assert.equal(params.hours * 60, minutes);
  }
});

test('the Full Access form payload enables, expires and returns to Protected', () => {
  const clock = clocked();
  const built = buildModeRequest('full-access', FULL_ACCESS_PHRASE, 5);
  assert.ok(built.ok);
  const state = clock.policy.setMode(built.value, surface());
  assert.equal(state.mode, 'full-access');
  assert.equal(state.modeExpiresAt! - state.modeIssuedAt!, 5 * 60 * 1000);

  // Inside the window an exec request is allowed without a prompt.
  return (async () => {
    assert.deepEqual(
      await clock.policy.evaluate({ capability: 'exec', target: 'windows' }, environment),
      { kind: 'allow', reason: 'full-access' },
    );

    clock.advance(5 * 60 * 1000 + 1);
    assert.equal(clock.policy.mode, 'protected');
    const after = await clock.policy.evaluate({ capability: 'exec', target: 'windows' }, environment);
    assert.equal(after.kind, 'ask');
  })();
});

// ------------------------------------------------------------ Grant form ----

test('grants separate the target system from the covered folder', () => {
  assert.deepEqual([...GRANT_TARGETS], ['windows', 'wsl']);
  assert.deepEqual([...GRANT_CAPABILITIES], ['exec', 'write', 'copy']);
  assert.equal(needsRoot('exec'), false);
  assert.equal(needsRoot('write'), true);
  assert.equal(needsRoot('copy'), true);

  const linux = buildGrantRequest({ capability: 'write', target: 'wsl', root: '/home/user/project', hours: 4 });
  assert.ok(linux.ok);
  assert.deepEqual(linux.value, {
    capability: 'write',
    target: 'wsl',
    root: '/home/user/project',
    hours: 4,
  });

  const windows = buildGrantRequest({ capability: 'copy', target: 'windows', root: 'C:\\Users\\me\\out', hours: 3 });
  assert.ok(windows.ok);
  assert.equal(windows.value.target, 'windows');
  assert.equal(windows.value.root, 'C:\\Users\\me\\out');
});

test('exec grants carry no root and reject one', () => {
  const built = buildGrantRequest({ capability: 'exec', target: 'wsl', root: '', hours: 1 });
  assert.ok(built.ok);
  assert.equal('root' in built.value, false);

  const withRoot = buildGrantRequest({ capability: 'exec', target: 'windows', root: 'C:\\', hours: 1 });
  assert.equal(withRoot.ok, false);
  if (!withRoot.ok) assert.equal(withRoot.error, 'ui.permissions.execNoRoot');
});

test('path capabilities require an absolute root for the chosen target', () => {
  const empty = buildGrantRequest({ capability: 'write', target: 'wsl', root: '   ', hours: 1 });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error, 'ui.permissions.rootRequired');

  for (const root of ['project', './project', '../project', 'C:\\Users']) {
    const built = buildGrantRequest({ capability: 'write', target: 'wsl', root, hours: 1 });
    assert.equal(built.ok, false, `${root} must not be accepted as a WSL root`);
    if (!built.ok) assert.equal(built.error, 'ui.permissions.rootInvalid');
  }

  for (const root of ['/mnt/c/Users', '/home/user', 'C:Users']) {
    const built = buildGrantRequest({ capability: 'write', target: 'windows', root, hours: 1 });
    assert.equal(built.ok, false, `${root} must not be accepted as a Windows root`);
    if (!built.ok) assert.equal(built.error, 'ui.permissions.rootInvalid');
  }

  // Forward slashes are a valid absolute Windows root, which the host accepts too.
  const forward = buildGrantRequest({ capability: 'write', target: 'windows', root: 'C:/Users/me', hours: 1 });
  assert.ok(forward.ok);
  assert.equal(forward.value.root, 'C:/Users/me');

  const normalized = buildGrantRequest({ capability: 'write', target: 'wsl', root: '  /home/user/project  ', hours: 1 });
  assert.ok(normalized.ok);
  assert.equal(normalized.value.root, '/home/user/project');
});

test('the grant lifetime must be a whole number of hours the host accepts', () => {
  assert.deepEqual([...GRANT_HOURS], [1, 4, 8, 24]);
  for (const hours of [0, -1, 25, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const built = buildGrantRequest({ capability: 'write', target: 'wsl', root: '/home/user', hours });
    assert.equal(built.ok, false, `${hours} must be rejected`);
    if (!built.ok) assert.equal(built.error, 'ui.permissions.hoursInvalid');
  }
  for (const hours of GRANT_HOURS) {
    const built = buildGrantRequest({ capability: 'write', target: 'wsl', root: '/home/user', hours });
    assert.ok(built.ok);
    assert.equal(built.value.hours, hours);
  }
});

test('a grant created from the form only covers its own target and folder', async () => {
  const clock = clocked();
  clock.policy.setMode({ mode: 'trusted' }, surface());
  const built = buildGrantRequest({ capability: 'write', target: 'wsl', root: '/home/user/project', hours: 4 });
  assert.ok(built.ok);
  const grant = clock.policy.addGrant(built.value);
  assert.equal(grant.target, 'wsl');
  assert.equal(grant.root, '/home/user/project');

  assert.equal(
    (await clock.policy.evaluate({ capability: 'write', target: 'wsl', path: '/home/user/project/a.txt' }, environment))
      .kind,
    'allow',
  );
  assert.equal(
    (await clock.policy.evaluate({ capability: 'write', target: 'wsl', path: '/home/user/other.txt' }, environment))
      .kind,
    'ask',
  );
  // The same capability on the other system is not covered by this grant.
  assert.equal(
    (await clock.policy.evaluate({ capability: 'write', target: 'windows', path: 'C:\\Users\\me\\a.txt' }, environment))
      .kind,
    'ask',
  );
});

test('a grant expires, and revoking it makes the operation ask again', async () => {
  const clock = clocked();
  clock.policy.setMode({ mode: 'trusted' }, surface());
  const built = buildGrantRequest({ capability: 'write', target: 'wsl', root: '/home/user/project', hours: 1 });
  assert.ok(built.ok);
  clock.policy.addGrant(built.value);

  clock.advance(HOUR + 1);
  assert.equal(
    (await clock.policy.evaluate({ capability: 'write', target: 'wsl', path: '/home/user/project/a.txt' }, environment))
      .kind,
    'ask',
  );

  const again = buildGrantRequest({ capability: 'write', target: 'wsl', root: '/home/user/project', hours: 2 });
  assert.ok(again.ok);
  const grant = clock.policy.addGrant(again.value);
  assert.equal(
    (await clock.policy.evaluate({ capability: 'write', target: 'wsl', path: '/home/user/project/a.txt' }, environment))
      .kind,
    'allow',
  );
  assert.equal(clock.policy.revoke(grant.id), true);
  assert.equal(
    (await clock.policy.evaluate({ capability: 'write', target: 'wsl', path: '/home/user/project/a.txt' }, environment))
      .kind,
    'ask',
  );
});

test('the host rejects a rooted exec grant the panel can never build', () => {
  const policy = new PermissionPolicy();
  assert.throws(
    () => policy.addGrant({ capability: 'exec', target: 'windows', root: 'C:\\Users\\me', hours: 1 }),
    (error: Error & { code?: string }) => error.code === 'INVALID_ARGUMENT',
  );
});

test('a Windows grant does not authorize Linux writes', async () => {
  const clock = clocked();
  clock.policy.setMode({ mode: 'trusted' }, surface());
  const built = buildGrantRequest({ capability: 'write', target: 'windows', root: 'C:\\Users\\me', hours: 4 });
  assert.ok(built.ok);
  clock.policy.addGrant(built.value);
  assert.equal(
    (await clock.policy.evaluate({ capability: 'write', target: 'wsl', path: '/home/user/project/a.txt' }, environment))
      .kind,
    'ask',
  );
});
