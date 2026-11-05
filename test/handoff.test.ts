import assert from 'node:assert/strict';
import test from 'node:test';
import { appOrigin, handoffUrl, localOrigin, parentUrl, readHandoff } from '../src/handoff.js';
import { signHandoff, verifyHandoff } from '../src/handoff-auth.js';

const secret = 'a'.repeat(64);

const payload = {
  id: 'handoff-1',
  distro: 'Ubuntu',
  user: 'user',
  directory: '/home/user/project',
  parentOrigin: 'dsh-app://app',
};

test('only loopback and Desktop origins are accepted', () => {
  assert.equal(appOrigin('dsh-app://app'), 'dsh-app://app');
  assert.equal(appOrigin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  assert.equal(appOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(appOrigin('https://example.com'), null);
  assert.equal(appOrigin('http://127.0.0.1:5173/path'), null);
  assert.equal(appOrigin('http://user:pass@127.0.0.1:5173'), null);
  assert.equal(localOrigin(42), null);
});

test('the parent URL returns to the Desktop or the local origin', () => {
  assert.equal(parentUrl('dsh-app://app'), 'dsh://open');
  assert.equal(parentUrl('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  assert.equal(parentUrl('https://evil.example'), null);
});

test('signed handoffs verify, and any field change invalidates them', () => {
  const signed = signHandoff(payload, secret);
  assert.equal(verifyHandoff(signed, secret), true);
  assert.equal(verifyHandoff({ ...signed, directory: '/home/user/other' }, secret), false);
  assert.equal(verifyHandoff({ ...signed, distro: 'Debian' }, secret), false);
  assert.equal(verifyHandoff(signed, undefined), false);
});

test('expired and future-dated handoffs are rejected', () => {
  const now = Date.now();
  const stale = signHandoff(payload, secret, now - 25 * 60 * 60 * 1000);
  assert.equal(verifyHandoff(stale, secret, now), false);
  const future = signHandoff(payload, secret, now + 10 * 60 * 1000);
  assert.equal(verifyHandoff(future, secret, now), false);
});

test('handoff links only target verified loopback URLs', () => {
  const signed = signHandoff(payload, secret);
  const url = new URL(handoffUrl('http://127.0.0.1:4321/', signed));
  assert.equal(url.origin, 'http://127.0.0.1:4321');
  const parsed = readHandoff(url.hash);
  assert.equal(parsed?.id, payload.id);
  assert.equal(parsed?.directory, payload.directory);
  assert.equal(parsed?.parentOrigin, 'dsh-app://app');
  assert.throws(() => handoffUrl('https://example.com/', signed));
});

test('unexpected handoff fragments are ignored', () => {
  assert.equal(readHandoff(null), null);
  assert.equal(readHandoff('#other=1'), null);
  assert.equal(readHandoff('#dsh-wsl=not-json'), null);
  assert.equal(
    readHandoff('#dsh-wsl=' + encodeURIComponent(JSON.stringify({ ...payload, directory: 'relative' }))),
    null,
  );
});
