// Compile the TypeScript sources and tests to plain ESM, then run node:test.
// Keeping the test runner on compiled output means the suite exercises the same
// JavaScript shape Node executes in production (no loader hooks, no transpiler).
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorker } from './build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = path.join(root, '.test-build');

await fs.mkdir(outdir, { recursive: true });
await fs.mkdir(path.join(root, 'dist'), { recursive: true });
await buildWorker();

await build({
  absWorkingDir: root,
  entryPoints: ['src/**/*.ts', 'test/*.test.ts', 'test/legacy/*.test.mjs'],
  outbase: '.',
  outdir: '.test-build',
  bundle: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  loader: { '.css': 'text' },
});

// `node --test <pattern>` also accepts file globs from Node 22 onward.
const args = process.argv.slice(2);
// Both the TypeScript suites and the migrated upstream suites run in one go.
const nodeArgs = [
  '--test',
  ...(args.length
    ? args
    : ['.test-build/test/*.test.js', '.test-build/test/legacy/*.test.js']),
];
const child = spawn(process.execPath, nodeArgs, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    // The worker is injected as a self-contained bundle, so tests must use the
    // built artifact rather than the unbundled test tree.
    DSH_WSL_WORKER: path.join(root, 'dist', 'worker.js'),
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
  },
});
child.once('exit', (code) => process.exit(code ?? 1));
