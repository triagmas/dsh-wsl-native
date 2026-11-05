import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess, powershellArgs, powershellPath, psLiteral } from './process.js';
import { BridgeError, ensure, aborted } from './errors.js';
import { t } from './i18n/index.js';

/** Package metadata subset used for platform compatibility checks. */
export interface PackagePlatform {
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

/** Dependency lock entry used to select Linux download URLs. */
interface LockEntry extends PackagePlatform {
  resolved?: string;
}

/** Result of preparing the Windows npm cache for a Linux install. */
export interface PreparedCache {
  packageJson: string;
  lockText: string;
  packages: number;
}

/**
 * npm platform rules: an absent field permits everything, a list of only
 * negations excludes them, and a positive list must contain the value.
 */
export function matchesPlatform(entry: PackagePlatform, arch: string): boolean {
  const permits = (list: string[] | undefined, value: string): boolean =>
    !list || (!list.includes('!' + value) && (list.every((item) => item.startsWith('!')) || list.includes(value)));
  return permits(entry.os, 'linux') && permits(entry.cpu, arch) && permits(entry.libc, 'glibc');
}

/**
 * Windows npm resolves and downloads; Linux npm performs extraction and runs
 * install scripts. The cache is content-addressed, so reusing it changes no
 * global npm, proxy, DNS or firewall configuration.
 */
export async function prepareWindowsCache(options: {
  version?: string;
  arch: string;
  cache: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  packageJson?: unknown;
  legacyPeers?: boolean;
}): Promise<PreparedCache> {
  const { version, arch, cache, signal, onProgress, packageJson, legacyPeers = false } = options;
  ensure(['x64', 'arm64'].includes(arch), 'UNSUPPORTED_ARCH', 'install.unsupportedArch');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wsl-install-'));
  const run = async (args: string[]): Promise<void> => {
    aborted(signal);
    const result = await runProcess(
      powershellPath(),
      powershellArgs(`& npm ${args.map(psLiteral).join(' ')}; exit $LASTEXITCODE`),
      { cwd: directory, signal, timeoutMs: 600000, maxOutputBytes: 16384 },
    );
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
      throw new BridgeError(
        'NPM_DOWNLOAD_FAILED',
        t('install.npmFailed', { error: result.stderr || result.stdout || '' }),
      );
    }
  };
  try {
    const manifest = packageJson ?? {
      name: 'dsh-wsl-managed-runtime',
      version: '1.0.0',
      private: true,
      dependencies: { '@deepseek-ai/dsh': version },
    };
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
    const flags = ['--cache', cache, '--fetch-retries=1', '--fetch-timeout=20000', '--no-audit', '--no-fund'];
    onProgress?.('Resolving the Linux DSH dependency graph with Windows npm.');
    await run([
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--prefer-online',
      '--os=linux',
      `--cpu=${arch}`,
      '--libc=glibc',
      ...(legacyPeers ? ['--legacy-peer-deps'] : []),
      ...flags,
    ]);
    const lockText = await fs.readFile(path.join(directory, 'package-lock.json'), 'utf8');
    const lock = JSON.parse(lockText) as { packages: Record<string, LockEntry> };
    const urls = [
      ...new Set(
        Object.values(lock.packages)
          .filter((entry) => entry.resolved && !entry.resolved.startsWith('file:') && matchesPlatform(entry, arch))
          .map((entry) => entry.resolved as string),
      ),
    ];
    ensure(
      urls.every((url) => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
        } catch {
          return false;
        }
      }),
      'INVALID_PACKAGE_SOURCE',
      'install.invalidSource',
    );
    for (let index = 0; index < urls.length; index += 20) {
      onProgress?.(`Windows is caching dependencies: ${Math.min(index + 20, urls.length)}/${urls.length}.`);
      await run(['cache', 'add', '--prefer-offline', ...flags, ...urls.slice(index, index + 20)]);
    }
    return {
      packageJson: await fs.readFile(path.join(directory, 'package.json'), 'utf8'),
      lockText,
      packages: urls.length,
    };
  } finally {
    // Only remove files generated in this fresh temporary directory; no recursive deletion.
    for (const file of ['package.json', 'package-lock.json']) {
      await fs.unlink(path.join(directory, file)).catch(() => {});
    }
    await fs.rmdir(directory).catch(() => {});
  }
}
