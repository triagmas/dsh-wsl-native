import assert from 'node:assert/strict';
import test from 'node:test';
import { inheritableYamlText, mergeInherited, mergePatchLayers, parseInheritableYaml } from '../src/inheritance.js';
import { matchesPlatform } from '../src/install-cache.js';

test('platform rules follow the npm os/cpu/libc semantics', () => {
  assert.equal(matchesPlatform({}, 'x64'), true);
  assert.equal(matchesPlatform({ os: ['linux'], cpu: ['x64'] }, 'x64'), true);
  assert.equal(matchesPlatform({ os: ['linux'], cpu: ['arm64'] }, 'x64'), false);
  assert.equal(matchesPlatform({ os: ['!win32'] }, 'x64'), true);
  assert.equal(matchesPlatform({ os: ['!linux'] }, 'x64'), false);
  assert.equal(matchesPlatform({ os: ['linux', '!linux'] }, 'x64'), false);
  assert.equal(matchesPlatform({ libc: ['musl'] }, 'x64'), false);
});

test('the first synchronization follows the source profile', () => {
  const result = mergeInherited({}, { theme: 'dark', model: 'a' }, null);
  assert.deepEqual(result.value, { theme: 'dark', model: 'a' });
  assert.equal(result.overrides, 0);
});

test('local changes survive later synchronizations', () => {
  const first = mergeInherited({}, { theme: 'dark', model: 'a' }, null);
  const local = { theme: 'light', model: 'a' };
  const second = mergeInherited(local, { theme: 'blue', model: 'b' }, first.baseline);
  assert.deepEqual(second.value, { theme: 'light', model: 'b' });
  assert.equal(second.overrides, 1);
});

test('a local deletion is preserved instead of being silently resurrected', () => {
  const first = mergeInherited({ a: 1, b: 2 }, { a: 1, b: 2 }, null);
  const deleted = { a: 1 };
  const same = mergeInherited(deleted, { a: 1, b: 2 }, first.baseline);
  assert.deepEqual(same.value, { a: 1 });
  assert.equal(same.overrides, 1);

  const changed = mergeInherited(deleted, { a: 1, b: 3 }, first.baseline);
  assert.deepEqual(changed.value, { a: 1 });
  assert.equal(changed.overrides, 1);
});

test('credential records stay atomic', () => {
  const current = { openai: { kind: 'api-key', key: 'local', expiresAt: 1 } };
  const incoming = { openai: { kind: 'api-key', key: 'from-main', expiresAt: 2 } };
  const first = mergeInherited({}, incoming, null);
  const result = mergeInherited(current, incoming, first.baseline);
  assert.deepEqual(result.value, { openai: { kind: 'api-key', key: 'local', expiresAt: 1 } });
  assert.equal(result.overrides, 1);
});

test('Cordis patch layers merge by row id and keep order', () => {
  const current = [{ id: 'base' }, { id: 'linux-only' }];
  const incoming = [{ id: 'base' }, { id: 'inherited' }];
  const first = mergePatchLayers(current, incoming, null);
  assert.deepEqual(first.value, [{ id: 'base' }, { id: 'inherited' }, { id: 'linux-only' }]);
  const second = mergePatchLayers(first.value, incoming, first.baseline);
  assert.deepEqual(second.value, [{ id: 'base' }, { id: 'inherited' }, { id: 'linux-only' }]);
  assert.equal(second.overrides, 0);
});

test('Cordis expressions survive a YAML round-trip', () => {
  const source = 'plugins:\n  demo:\n    interval: !!js/expression 1000 * 60\n';
  const parsed = parseInheritableYaml<Record<string, unknown>>(source, {});
  assert.match(inheritableYamlText(parsed), /!!js\/expression/);
});

test('invalid YAML is refused instead of silently ignored', () => {
  assert.throws(() => parseInheritableYaml('a: [1,\n', {}));
  assert.deepEqual(parseInheritableYaml(null, []), []);
});
