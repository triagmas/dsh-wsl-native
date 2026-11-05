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
  entryPoints: [
    'src/index.ts',
    'src/worker.ts',
    'src/service.ts',
    'src/permissions/index.ts',
    'src/i18n/index.ts',
    'src/i18n/en.ts',
    'src/i18n/ru.ts',
    'src/i18n/zh-CN.ts',
    'test/*.test.ts',
  ],
  outbase: '.',
  outdir: '.test-build',
  bundle: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  loader: { '.css': 'text' },
});

/** Compile one changed source module on demand for the incremental watch loop. */
const args = process.argv.slice(2);
const nodeArgs = ['--test', ...(args.length ? args : ['.test-build/test/*.test.js'])];
const child = spawn(process.execPath, nodeArgs, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' },
});
child.once('exit', (code) => process.exit(code ?? 1));
