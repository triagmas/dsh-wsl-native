// Verify the packed archive: contents, size, secrets, temp files and licence.
// Runs on the current working tree, so `npm run verify` covers packaging too.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

// Windows exposes the npm shim as `npm.cmd`; execFile does not resolve shims.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const { stdout } = await run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root });
const [{ files, entryCount, size, unpackedSize }] = JSON.parse(stdout);
const names = files.map((file) => file.path).sort();
const problems = [];
const required = ['package.json', 'LICENSE', 'README.md', 'dist/index.js', 'dist/service.js', 'dist/cli.js', 'dist/worker.js', 'dist/client.js'];
for (const file of required) if (!names.includes(file)) problems.push(`missing ${file}`);
const forbidden = names.filter(
  (name) =>
    name.startsWith('src/') ||
    name.startsWith('test/') ||
    name.startsWith('node_modules/') ||
    name.includes('.test-build') ||
    /(^|\/)(\.env|.*\.tmp|.*\.log)$/.test(name),
);
for (const name of forbidden) problems.push(`forbidden ${name}`);
const secrets = /(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/;
for (const file of files) {
  const text = await fs.readFile(path.join(root, file.path), 'utf8').catch(() => '');
  if (secrets.test(text)) problems.push(`secret-like content in ${file.path}`);
}
const licence = await fs.readFile(path.join(root, 'LICENSE'), 'utf8');
if (!/MIT License/.test(licence)) problems.push('LICENSE is not the MIT licence');

if (problems.length) {
  for (const problem of problems) console.error(`[package] ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    `[package] ${manifest.name}@${manifest.version}: ${entryCount} files, ${unpackedSize} bytes unpacked, ${size} bytes packed — OK`,
  );
}
