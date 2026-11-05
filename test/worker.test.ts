import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from '../src/connector.js';
import { BridgeError } from '../src/errors.js';
import { MAX_FRAME, readFrames, writeFrame } from '../src/rpc.js';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { decodeChunk } from '../src/encoding.js';

test('frame decoding rejects oversized and malformed frames', () => {
  const stream = new PassThrough();
  const errors: Error[] = [];
  readFrames(stream, () => assert.fail('no frame expected'), (error) => errors.push(error));
  stream.write(Buffer.from(MAX_FRAME + 1 + '\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? '', /frame/i);

  const malformed = new PassThrough();
  readFrames(malformed, () => assert.fail('no frame expected'), (error) => errors.push(error));
  malformed.write('not json\n');
  assert.equal(errors.length, 2);
});

test('frames are framed by line and carry the payload unchanged', async () => {
  const stream = new PassThrough();
  const frames: unknown[] = [];
  readFrames(stream, (frame) => frames.push(frame), (error) => assert.fail(error.message));
  const payload = { type: 'request', id: '1', method: 'ping', params: { text: 'привет' } };
  await writeFrame(stream, payload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(frames, [payload]);
});

test('encoding decodes whole characters across a chunk boundary', () => {
  const text = Buffer.from('привет', 'utf8');
  const first = decodeChunk(text.subarray(0, 3), 'utf8', false);
  assert.equal(first.content, 'пр'.slice(0, 1) + '');
  const second = decodeChunk(text.subarray(first.bytes), 'utf8', true);
  assert.equal(first.content + second.content, 'привет');
  // A chunk that cannot hold one complete character is reported, never decoded partially.
  assert.throws(() => decodeChunk(Buffer.from([0xd0]), 'utf8', false));
  assert.equal(decodeChunk(Buffer.from('hello'), 'base64', true).content, Buffer.from('hello').toString('base64'));
});

test('the resident worker serves exec, files and jobs over stdio', async (t) => {
  const rpc = await connect({ target: 'local' });
  t.after(() => rpc.close());
  const info = await rpc.call('ping', {});
  assert.equal(info.platform, process.platform);
  assert.equal(info.pid > 0, true);

  const result = await rpc.call('exec', { executable: 'node', args: ['-e', 'process.stdout.write("ok")'], timeoutMs: 15000 });
  assert.equal(result.stdout, 'ok');
  assert.equal(result.exitCode, 0);

  const failure = await rpc.call('exec', { command: 'exit 3', timeoutMs: 15000 });
  assert.equal(failure.exitCode, 3);

  const job = await rpc.call('job.start', { executable: 'node', args: ['-e', 'setTimeout(() => process.stdout.write("done"), 150)'], timeoutMs: 15000 });
  let status = await rpc.call('job.status', { id: job.id });
  while (status.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await rpc.call('job.status', { id: job.id });
  }
  assert.equal(status.status, 'completed');
  assert.equal(status.stdout, 'done');
  assert.deepEqual(await rpc.call('job.forget', { id: job.id }), { removed: true });
  await assert.rejects(() => rpc.call('job.status', { id: job.id }), (error: unknown) => error instanceof BridgeError);
});

test('file writes are atomic, verified and conflict-checked', async (t) => {
  const rpc = await connect({ target: 'local' });
  t.after(() => rpc.close());
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-native-test-'));
  t.after(async () => {
    // Remove only the files this test created, then the directory itself.
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  });
  const file = path.join(directory, 'note.txt');
  const content = 'line one\nлиния два\n';
  const written = await rpc.call('file.write', { path: file, content, expectedHash: 'absent' });
  assert.equal(written.bytes, Buffer.byteLength(content));
  assert.equal(written.sha256, createHash('sha256').update(content).digest('hex'));

  const read = await rpc.call('file.read', { path: file });
  assert.equal(read.content, content);
  assert.equal(read.eof, true);

  await assert.rejects(
    () => rpc.call('file.write', { path: file, content: 'other', expectedHash: 'absent' }),
    (error: unknown) => error instanceof BridgeError && error.code === 'FILE_CONFLICT',
  );

  const stat = await rpc.call('file.stat', { path: file, hash: true });
  assert.equal(stat.bytes, Buffer.byteLength(content));

  const listing = await rpc.call('file.list', { path: directory });
  assert.deepEqual(
    listing.entries.map((entry: { name: string }) => entry.name),
    ['note.txt'],
  );

  const directoryInfo = await rpc.call('directory.resolve', { path: directory });
  assert.equal(directoryInfo.path, await fs.realpath(directory));
});

test('the runtime lock prevents a second launcher', async (t) => {
  const rpc = await connect({ target: 'local' });
  t.after(() => rpc.close());
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-native-lock-'));
  const lock = path.join(directory, 'runtime.lock');
  t.after(async () => {
    await fs.unlink(lock).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  });
  const lease = await rpc.call('lease.acquire', { path: lock });
  await assert.rejects(
    () => rpc.call('lease.acquire', { path: lock }),
    (error: unknown) => error instanceof BridgeError && error.code === 'RUNTIME_BUSY',
  );
  assert.deepEqual(await rpc.call('lease.release', { id: lease.id }), { released: true });
  await fs.access(lock).then(
    () => assert.fail('lock file must be removed'),
    () => {},
  );
});
