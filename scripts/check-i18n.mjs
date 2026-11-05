// Verify that every locale carries the complete key set with matching
// placeholders. The dictionaries are TypeScript, so this script bundles the
// real module with esbuild and inspects it at runtime — the same code path the
// plugin uses.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-i18n-'));
const outfile = path.join(directory, 'i18n.mjs');

try {
  await build({
    absWorkingDir: root,
    entryPoints: ['src/i18n/index.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
  });
  const { LOCALES, missingTranslations, DICTIONARIES, en } = await import(pathToFileURL(outfile).href);
  let failed = false;
  for (const locale of LOCALES) {
    const problems = missingTranslations(locale);
    const size = Object.keys(DICTIONARIES[locale] ?? {}).length;
    if (problems.length) {
      failed = true;
      console.error(`[i18n] ${locale}: ${problems.length} problem(s)`);
      for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
    } else {
      console.log(`[i18n] ${locale}: ${size} keys OK`);
    }
  }
  const englishKeys = Object.keys(en);
  for (const locale of LOCALES) {
    const extra = Object.keys(DICTIONARIES[locale] ?? {}).filter((key) => !englishKeys.includes(key));
    if (extra.length) {
      failed = true;
      console.error(`[i18n] ${locale}: unknown keys ${extra.join(', ')}`);
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`[i18n] ${LOCALES.length} locales, ${englishKeys.length} keys each.`);
} finally {
  await fs.unlink(outfile).catch(() => {});
  await fs.rmdir(directory).catch(() => {});
}
