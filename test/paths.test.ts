import assert from 'node:assert/strict';
import test from 'node:test';
import {
  distroName,
  linuxPath,
  parseDistros,
  parseWslUnc,
  shellQuote,
  toWslUnc,
  windowsToLinux,
} from '../src/paths.js';
import { BridgeError } from '../src/errors.js';

test('Linux paths are normalized and must be absolute', () => {
  assert.equal(linuxPath('/home/user/../user/project'), '/home/user/project');
  // A trailing separator is preserved: it is significant for root comparisons.
  assert.equal(linuxPath('/home/user/project/'), '/home/user/project/');
  assert.throws(() => linuxPath('home/user'), (error: unknown) => error instanceof BridgeError);
});

test('distribution names reject separators and option-like values', () => {
  assert.equal(distroName('Ubuntu-24.04'), 'Ubuntu-24.04');
  assert.throws(() => distroName('--help'));
  assert.throws(() => distroName('a/b'));
  assert.throws(() => distroName('a\nb'));
});

test('WSL UNC paths round-trip through the canonical form', () => {
  assert.deepEqual(parseWslUnc('\\\\wsl.localhost\\Ubuntu\\home\\user\\project'), {
    distro: 'Ubuntu',
    path: '/home/user/project',
  });
  assert.deepEqual(parseWslUnc('\\\\wsl$\\Ubuntu'), { distro: 'Ubuntu', path: '/' });
  assert.equal(parseWslUnc('C:\\Work'), null);
  assert.equal(toWslUnc('/home/user/project', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\user\\project');
  assert.throws(() => toWslUnc('/home/user/a:b', 'Ubuntu'));
});

test('Windows drive letters map onto the default mount root', () => {
  assert.equal(windowsToLinux('C:\\Work\\Project'), '/mnt/c/Work/Project');
  assert.equal(windowsToLinux('D:\\'), '/mnt/d');
  assert.equal(windowsToLinux('\\\\wsl.localhost\\Ubuntu\\home'), '/home');
  assert.throws(() => windowsToLinux('\\\\wsl.localhost\\Debian\\home', 'Ubuntu'));
  assert.throws(() => windowsToLinux('relative\\path'));
});

test('wsl.exe output is parsed in UTF-16LE and UTF-8 forms', () => {
  const text = '  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n  Debian    Stopped         1\r\n';
  const utf16 = Buffer.from(text, 'utf16le');
  const rows = parseDistros(utf16);
  assert.deepEqual(rows, [
    { name: 'Ubuntu', state: 'Running', version: 2, isDefault: true },
    { name: 'Debian', state: 'Stopped', version: 1, isDefault: false },
  ]);
  assert.equal(parseDistros(text).length, 2);
});

test('docker-desktop helper distributions are ignored', () => {
  const rows = parseDistros('  docker-desktop    Running         2\n  Ubuntu            Running         2\n');
  assert.deepEqual(
    rows.map((row) => row.name),
    ['Ubuntu'],
  );
});

test('shell quoting keeps single quotes literal', () => {
  assert.equal(shellQuote('/home/user'), "'/home/user'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
