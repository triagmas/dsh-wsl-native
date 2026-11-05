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
  entryPoints: ['src/**/*.ts', 'src/**/*.mjs', 'test/*.test.ts', 'test/legacy/*.test.mjs'],
  outbase: '.',
  outdir: '.test-build',
  bundle: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  loader: { '.css': 'text' },
});

// esbuild renames `.mjs` inputs to `.js` outputs; rewrite imports that still
// name a `.mjs` file so the compiled tree stays linked.
for (const directory of [path.join(outdir, 'src'), path.join(outdir, 'test', 'legacy')]) {
  const names = await fs.readdir(directory).catch(() => []);
  for (const name of names.filter((item) => item.endsWith('.js'))) {
    const file = path.join(directory, name);
    const text = await fs.readFile(file, 'utf8');
    const rewritten = text.replace(/(from\s+["'][^"']+)\.mjs(["'])/g, '$1.js$2');
    if (rewritten !== text) await fs.writeFile(file, rewritten);
  }
}

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
