import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { stringifyString } from 'yaml/util';
import { runProcess, powershellArgs, powershellPath, psLiteral } from './process.js';
import { prepareWindowsCache, matchesPlatform, type PackagePlatform } from './install-cache.js';
import { shellQuote } from './paths.js';
import { ensure, aborted } from './errors.js';
import { t } from './i18n/index.js';
import type { JobOwner, WslService } from './service.js';
import type { NativeLocations } from './launcher.js';

/** Inheritance switches, all enabled by default. */
export interface InheritanceOptions {
  plugins: boolean;
  config: boolean;
  credentials: boolean;
}

/** Source profile the Linux environment inherits from. */
export interface SourceProfile {
  home: string;
  dir: string;
  name: string;
}

/** Persisted status shown in the panel. */
export interface InheritanceStatus {
  available: boolean;
  source: string | null;
  options: InheritanceOptions;
  applied: InheritanceReport | null;
}

/** One inherited plugin and its outcome. */
export interface InheritedPluginReport {
  name: string;
  version: string;
  status: 'inherited' | 'overridden' | 'unsupported';
  reason?: string;
}

/** Report of the last synchronization. */
export interface InheritanceReport {
  date: string;
  source: string | null;
  plugins: InheritedPluginReport[];
  overrides: number;
  settings: boolean;
  credentials: boolean;
}

/** Installed plugin discovered in the source profile. */
interface PluginEntry {
  name: string;
  version: string;
  directory: string;
  pkg: PackagePlatform & { name: string; version: string; main?: string };
  fingerprint: string;
}

/** Baseline of inherited values, keyed by JSON-encoded field path. */
type Baseline = Record<string, string>;

const defaults: InheritanceOptions = { plugins: true, config: true, credentials: true };
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/** Stable content hash used for baselines and cache keys. */
const digest = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');

/** Custom YAML tag preserving Cordis `!!js/...` expressions during inheritance. */
class Expression {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const tags = [
  {
    tag: 'tag:yaml.org,2002:js',
    identify: (value: unknown): boolean => value instanceof Expression,
    resolve: (value: string): Expression => new Expression(value),
    stringify: (
      item: { value: unknown },
      ctx: Parameters<typeof stringifyString>[1],
      onComment: Parameters<typeof stringifyString>[2],
      onChompKeep: Parameters<typeof stringifyString>[3],
    ): string =>
      stringifyString({ ...item, value: String(item.value) }, ctx, onComment, onChompKeep),
  },
];

type Plain = Record<string, unknown>;

const plain = (value: unknown): value is Plain =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Expression);

/** Parse inheritable YAML; refuses documents with errors or warnings. */
export function parseInheritableYaml<T>(text: string | null | undefined, fallback: T): T {
  if (!text?.trim()) return fallback;
  const doc = parseDocument(text, { customTags: tags, prettyErrors: false, uniqueKeys: true });
  ensure(!doc.errors.length && !doc.warnings.length, 'INHERIT_CONFIG', 'inherit.yamlInvalid');
  return (doc.toJS({ maxAliasCount: 100 }) as T | null) ?? fallback;
}

/** Serialize inheritable YAML, preserving expression tags. */
export const inheritableYamlText = (value: unknown): string =>
  stringify(value, { customTags: tags, lineWidth: 0 });

/** Flatten nested plain objects into JSON-path keyed leaves. */
function flatten(value: unknown, prefix: string[] = [], map = new Map<string, unknown>()): Map<string, unknown> {
  if (plain(value) && !prefix.length && !Object.keys(value).length) return map;
  // Authorization records are one unit: token and expiry must never be mixed.
  if (plain(value) && !['grant', 'api-key'].includes(String(value.kind)) && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) flatten(child, [...prefix, key], map);
  } else {
    map.set(JSON.stringify(prefix), value);
  }
  return map;
}

/** Rebuild a nested object from JSON-path keyed leaves. */
function expand(map: Map<string, unknown>): unknown {
  let root: unknown = Object.create(null);
  for (const [encoded, value] of map) {
    const keys = JSON.parse(encoded) as string[];
    if (!keys.length) {
      root = value;
      continue;
    }
    let parent = root as Plain;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(parent, key) || !plain(parent[key])) {
        Object.defineProperty(parent, key, {
          value: Object.create(null),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      parent = parent[key] as Plain;
    }
    Object.defineProperty(parent, keys.at(-1) as string, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return root;
}

/** Result of a three-way (current, incoming, baseline) merge. */
export interface MergeResult {
  value: unknown;
  baseline: Baseline;
  overrides: number;
}

/**
 * Three-way merge: values still equal to the recorded baseline follow the
 * source, values changed locally stay local and are counted as overrides.
 */
export function mergeInherited(current: unknown, incoming: unknown, baseline: Baseline | null = null): MergeResult {
  const target = flatten(current);
  const source = flatten(incoming);
  const hashes: Baseline = Object.create(null);
  const ancestor = (a: string, b: string): boolean => a === b || a === '[]' || b.startsWith(a.slice(0, -1) + ',');
  const overlaps = (a: string, b: string): boolean => ancestor(a, b) || ancestor(b, a);
  let overrides = 0;
  for (const [key, value] of source) {
    const hash = digest(value);
    hashes[key] = hash;
    const conflicts = [...target.keys()].filter((candidate) => overlaps(candidate, key));
    const deleted = baseline && Object.keys(baseline).some((candidate) => overlaps(candidate, key) && !target.has(candidate));
    const unchanged = !baseline || (!deleted && conflicts.every((candidate) => digest(target.get(candidate)) === baseline[candidate]));
    if (unchanged) {
      for (const candidate of conflicts) target.delete(candidate);
      target.set(key, value);
    } else if (!target.has(key) || digest(target.get(key)) !== hash) {
      overrides++;
    }
  }
  for (const [key, hash] of Object.entries(baseline || {})) {
    if (!source.has(key) && target.has(key) && digest(target.get(key)) === hash) target.delete(key);
  }
  return { value: expand(target), baseline: hashes, overrides };
}

/** Merge Cordis patch layers, keeping rows keyed by id when present. */
export function mergePatchLayers(current: unknown, incoming: unknown, baseline: Baseline | null): MergeResult {
  ensure(Array.isArray(current) && Array.isArray(incoming), 'INHERIT_CONFIG', 'inherit.invalidLayer');
  const keyed = (rows: unknown[]): Plain =>
    Object.fromEntries(
      rows.map((row, index) => [
        typeof (row as Plain)?.id === 'string' ? 'id:' + String((row as Plain).id) : 'row:' + index,
        row,
      ]),
    );
  const result = mergeInherited(keyed(current), keyed(incoming), baseline);
  return { ...result, value: Object.values(result.value as Plain) };
}

async function optional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

/** Persisted per-environment state of the inheritance feature. */
interface StoredInheritance {
  options?: Partial<InheritanceOptions>;
  applied?: InheritanceReport;
  dependencies?: Baseline;
  bundles?: Baseline;
  files?: Record<string, Baseline>;
  date?: string;
}

/**
 * Mirrors the main environment into the isolated Linux DSH profile.
 *
 * Only this plugin reads the Windows profile. Nothing is written to a real
 * project: every path below is inside the Linux installation directory created
 * by `dsh-wsl setup`, and the Windows source profile is only read.
 */
export class ProfileInheritance {
  private readonly service: WslService;
  private readonly source: SourceProfile | undefined;
  readonly preferences: string;

  constructor(service: WslService, source: SourceProfile | undefined = service.config.sourceProfile) {
    this.service = service;
    this.source = source;
    const key = digest([service.settings.distro, service.settings.user]).slice(0, 24);
    this.preferences = path.join(
      service.config.inheritanceStateHome ||
        source?.home ||
        process.env.DSH_HOME ||
        path.join(os.homedir(), '.dsh'),
      'dsh-wsl-native',
      'inheritance',
      key + '.json',
    );
  }

  private async stored(): Promise<StoredInheritance> {
    return JSON.parse((await optional(this.preferences)) || '{}') as StoredInheritance;
  }

  /** Current options and the last applied report. */
  async status(): Promise<InheritanceStatus> {
    const saved = await this.stored();
    return {
      available: !!this.source && process.platform === 'win32',
      source: this.source?.name ?? null,
      options: { ...defaults, ...saved.options },
      applied: saved.applied ?? null,
    };
  }

  /** Update one or more switches. */
  async configure(options: Partial<Record<keyof InheritanceOptions, unknown>>): Promise<InheritanceStatus> {
    ensure(
      this.source &&
        options &&
        Object.keys(options).every((key) => key in defaults && typeof options[key as keyof InheritanceOptions] === 'boolean'),
      'INVALID_ARGUMENT',
      'inherit.invalidOption',
    );
    const saved = await this.stored();
    await atomic(this.preferences, {
      ...saved,
      options: { ...defaults, ...saved.options, ...(options as Partial<InheritanceOptions>) },
    });
    return this.status();
  }

  /** Read installed plugins from the source profile manifest. */
  async inventory(): Promise<{ manifest: Plain; plugins: PluginEntry[] }> {
    if (!this.source) return { manifest: null as unknown as Plain, plugins: [] };
    const manifest = JSON.parse(
      await fs.readFile(path.join(this.source.dir, 'package.json'), 'utf8'),
    ) as Plain;
    const names = Object.keys((manifest.dependencies as Record<string, string>) || {}).filter(
      (name) => name !== 'dsh-wsl-native',
    );
    const plugins: PluginEntry[] = [];
    for (const name of names) {
      ensure(packageName.test(name), 'INHERIT_PLUGIN', 'inherit.pluginName');
      const directory = await fs.realpath(path.join(this.source.dir, 'node_modules', name));
      const json = await fs.readFile(path.join(directory, 'package.json'), 'utf8');
      const pkg = JSON.parse(json) as PluginEntry['pkg'];
      ensure(pkg.name === name, 'INHERIT_PLUGIN', 'inherit.pluginMismatch');
      const hash = createHash('sha256').update(directory).update(json);
      for (const file of [pkg.main, 'lib/client.js', 'cordis.patch.yml'].filter(
        (value): value is string =>
          typeof value === 'string' && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'),
      )) {
        hash.update((await optional(path.join(directory, file))) || '');
      }
      plugins.push({ name, version: pkg.version, directory, pkg, fingerprint: hash.digest('hex') });
    }
    return { manifest, plugins };
  }

  /** Apply the inheritance options into the isolated Linux profile. */
  async apply(
    locations: NativeLocations,
    context: {
      distro: string;
      signal?: AbortSignal;
      npmCache?: string;
      onProgress?: (text: string) => void;
      jobUntilDone: (id: string, options: { distro: string; signal?: AbortSignal }) => Promise<unknown>;
    },
  ): Promise<InheritanceReport | null> {
    if (!this.source || process.platform !== 'win32') return null;
    const { options } = await this.status();
    if (!Object.values(options).some(Boolean)) return null;
    const rpc = { distro: context.distro, signal: context.signal };
    const service = this.service;
    const execute = async (
      executable: string,
      args: string[],
      extra: Record<string, unknown> = {},
    ): Promise<void> => {
      const result = await service.execute('wsl', { executable, args, cwd: '/', timeoutMs: 30000, ...extra }, rpc);
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(t('inherit.failed', { error: result.stderr })), { code: 'INHERIT_FAILED' });
      }
    };
    const read = async (file: string): Promise<string | null> => {
      try {
        const result = (await service.files('wsl', 'read', { path: file, limit: 262144 }, rpc)) as {
          content: string;
          eof?: boolean;
        };
        ensure(result.eof !== false, 'INHERIT_CONFIG', 'inherit.configTooLarge');
        return result.content;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const write = (file: string, content: string, previous: string | null): Promise<unknown> =>
      service.files(
        'wsl',
        'write',
        { path: file, content, expectedHash: previous === null ? 'absent' : digest(previous) },
        rpc,
      );
    const web = `${locations.dshHome}/profiles/web`;
    const stateFile = `${locations.base}/inheritance-state.json`;
    const stateText = await read(stateFile);
    const previous = JSON.parse(stateText || '{}') as StoredInheritance;
    const next: StoredInheritance = { ...previous, files: { ...previous.files } };
    const backup = `${locations.base}/backups/inherit-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await execute('mkdir', ['-p', '--', web, `${web}/node_modules`, backup]);
    await execute('chmod', ['700', backup]);
    const changes: { file: string; content: string; previous: string | null }[] = [];
    const report: InheritanceReport = {
      date: new Date().toISOString(),
      source: this.source.name,
      plugins: [],
      overrides: 0,
      settings: options.config,
      credentials: options.credentials,
    };
    const save = async (file: string, content: string): Promise<void> => {
      const before = await read(file);
      if (before === content) return;
      if (before !== null) await write(`${backup}/${changes.length}-${path.posix.basename(file)}`, before, null);
      changes.push({ file, content, previous: before });
    };
    context.onProgress?.(t('inherit.progress.merge'));
    if (options.plugins) {
      const { manifest, plugins } = await this.inventory();
      const info = await service.ping('wsl', { distro: context.distro });
      const compatible = plugins.filter((item) => {
        if (matchesPlatform(item.pkg, info.arch)) return true;
        report.plugins.push({
          name: item.name,
          version: item.version,
          status: 'unsupported',
          reason: 'The plugin declares no support for this Linux platform.',
        });
        return false;
      });
      const cacheDirectory = path.join(this.source.home, 'dsh-wsl-native', 'plugin-cache');
      await fs.mkdir(cacheDirectory, { recursive: true });
      const packages: (PluginEntry & { local: string; linux: string })[] = [];
      for (const item of compatible) {
        aborted(context.signal);
        const directory = path.join(cacheDirectory, item.fingerprint);
        await fs.mkdir(directory, { recursive: true });
        let packed = JSON.parse(
          (await optional(path.join(directory, 'packed.json'))) || 'null',
        ) as { filename: string } | null;
        if (!packed || !(await fs.stat(path.join(directory, packed.filename)).catch(() => null))) {
          const result = await runProcess(
            powershellPath(),
            powershellArgs(
              `& npm pack --ignore-scripts --json --pack-destination ${psLiteral(directory)} ${psLiteral(item.directory)}; exit $LASTEXITCODE`,
            ),
            { signal: context.signal, timeoutMs: 120000, maxOutputBytes: 262144 },
          );
          ensure(result.exitCode === 0, 'INHERIT_PLUGIN', 'inherit.packFailed', { name: item.name });
          packed = (JSON.parse(result.stdout) as { filename: string }[])[0] as { filename: string };
          ensure(
            path.basename(packed.filename) === packed.filename,
            'INHERIT_PLUGIN',
            'inherit.packName',
          );
          await atomic(path.join(directory, 'packed.json'), { filename: packed.filename });
        }
        packages.push({
          ...item,
          local: path.join(directory, packed.filename),
          linux: `${locations.base}/plugin-packages/${item.fingerprint}.tgz`,
        });
      }
      const manifestFile = `${web}/package.json`;
      const currentText = await read(manifestFile);
      const current = JSON.parse(
        currentText ||
          '{"name":"dsh-profile-web","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}',
      ) as Plain;
      const incoming = Object.fromEntries(packages.map((item) => [item.name, 'file:' + item.linux]));
      const merged = mergeInherited(
        (current.dependencies as Record<string, string>) || {},
        incoming,
        previous.dependencies ?? null,
      );
      report.overrides += merged.overrides;
      next.dependencies = merged.baseline;
      const mergedDependencies = merged.value as Record<string, string>;
      const inherited = packages.filter((item) => mergedDependencies[item.name] === incoming[item.name]);
      const layerId = digest(Object.fromEntries(inherited.map((item) => [item.name, item.fingerprint]))).slice(0, 24);
      const layer = `${locations.base}/plugin-layers/${layerId}`;
      if (inherited.length && !(await read(`${layer}/.complete`))) {
        await execute('mkdir', ['-p', '--', layer, `${locations.base}/plugin-packages`]);
        for (const item of inherited) {
          const found = await service.files('wsl', 'stat', { path: item.linux }, rpc).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          if (!found) {
            await service.copy({
              from: 'windows',
              to: 'wsl',
              source: item.local,
              destination: item.linux,
              distro: context.distro,
              signal: context.signal,
            });
          }
        }
        let npmCache = context.npmCache;
        if (!npmCache) {
          const result = await service.execute('windows', { command: 'npm config get cache', timeoutMs: 15000 }, {
            signal: context.signal,
          });
          ensure(result.exitCode === 0, 'NPM_CACHE_REQUIRED', 'inherit.windowsCache');
          npmCache = result.stdout.trim();
        }
        const sourcePackage = {
          name: 'dsh-wsl-inherited-plugins',
          version: '1.0.0',
          private: true,
          dependencies: Object.fromEntries(
            inherited.map((item) => [item.name, 'file:' + item.local.replaceAll('\\', '/')]),
          ),
        };
        const cached = await prepareWindowsCache({
          packageJson: sourcePackage,
          arch: info.arch,
          cache: npmCache,
          legacyPeers: true,
          signal: context.signal,
          onProgress: context.onProgress,
        });
        const lock = JSON.parse(cached.lockText) as {
          packages: Record<string, { dependencies?: Record<string, string>; resolved?: string }>;
        };
        const linuxPackage = {
          ...sourcePackage,
          dependencies: Object.fromEntries(inherited.map((item) => [item.name, 'file:' + item.linux])),
        };
        (lock.packages[''] as { dependencies: Record<string, string> }).dependencies = linuxPackage.dependencies;
        for (const item of inherited) {
          const record = lock.packages['node_modules/' + item.name];
          ensure(record, 'INHERIT_PLUGIN', 'inherit.missingPluginRecord', { name: item.name });
          record.resolved = 'file:' + item.linux;
        }
        await write(`${layer}/package.json`, JSON.stringify(linuxPackage), await read(`${layer}/package.json`));
        await write(`${layer}/package-lock.json`, JSON.stringify(lock), await read(`${layer}/package-lock.json`));
        const cache = (await service.convert(npmCache, 'linux', rpc)).path;
        context.onProgress?.(t('inherit.progress.install'));
        const job = (await service.job(
          'wsl',
          'start',
          {
            command: `npm ci --offline --legacy-peer-deps --no-audit --no-fund --cache ${shellQuote(cache)}`,
            cwd: layer,
            timeoutMs: 600000,
          },
          rpc,
        )) as { id: string };
        await context.jobUntilDone(job.id, rpc);
        await write(`${layer}/.complete`, 'ready', null);
      }
      // Resolve only plugin directories through Linux symlinks. Runtime dependencies
      // are installed in Linux, and the original Windows node_modules is never used.
      if (inherited.length) {
        await execute(locations.node, [
          '-e',
          `const fs=require('fs'),path=require('path');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);for(const n of p.names){const dest=path.join(p.profile,'node_modules',n);fs.mkdirSync(path.dirname(dest),{recursive:true});try{const stat=fs.lstatSync(dest);if(stat.isSymbolicLink()&&fs.readlinkSync(dest)===path.join(p.layer,'node_modules',n))continue;const backup=path.join(p.backup,'plugin-'+n.replaceAll('/','_'));fs.renameSync(dest,backup);}catch(e){if(e.code!=='ENOENT')throw e;}fs.symlinkSync(path.join(p.layer,'node_modules',n),dest,'dir');}});`,
        ], { stdin: JSON.stringify({ names: inherited.map((item) => item.name), profile: web, layer, backup }) });
      }
      const dshProfile = (manifest.dsh as { profile?: { bundles?: string[] } } | undefined)?.profile;
      const sourceBundles = (dshProfile?.bundles || []).filter(
        (name) => name !== 'dsh-wsl-native' && !report.plugins.some((item) => item.name === name && item.status === 'unsupported'),
      );
      const currentBundles =
        (current.dsh as { profile?: { bundles?: string[] } } | undefined)?.profile?.bundles || [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
        ];
      const bundleMerge = mergeInherited(
        Object.fromEntries(currentBundles.map((name) => [name, true])),
        Object.fromEntries(sourceBundles.map((name) => [name, true])),
        previous.bundles ?? null,
      );
      next.bundles = bundleMerge.baseline;
      const mergedBundles = bundleMerge.value as Record<string, boolean>;
      const bundles = [...new Set([...sourceBundles, ...currentBundles])].filter((name) => mergedBundles[name]);
      current.dependencies = mergedDependencies;
      current.dsh = { ...(current.dsh as Plain), profile: { ...dshProfile, bundles } };
      await save(manifestFile, JSON.stringify(current, null, 2) + '\n');
      for (const item of packages) {
        report.plugins.push({
          name: item.name,
          version: item.version,
          status: inherited.includes(item) ? 'inherited' : 'overridden',
        });
      }
    }
    const filePairs: [string, string, string, boolean][] = [
      ['profile', path.join(this.source.dir, 'cordis.patch.yml'), `${web}/cordis.patch.yml`, false],
      ['home', path.join(this.source.home, 'cordis.patch.yml'), `${locations.dshHome}/cordis.patch.yml`, false],
      [
        'credentials',
        path.join(this.source.home, '.credentials.yaml'),
        `${locations.dshHome}/.credentials.yaml`,
        true,
      ],
    ];
    for (const [key, source, target, isCredentials] of filePairs) {
      if (!(isCredentials ? options.credentials : options.config)) continue;
      const sourceText = await optional(source);
      if (sourceText === null) continue;
      const currentText = await read(target);
      const fallback = isCredentials ? ({} as Plain) : ([] as unknown[]);
      const incoming = parseInheritableYaml<unknown>(sourceText, fallback);
      const current = parseInheritableYaml<unknown>(currentText, fallback);
      const baseline = previous.files?.[key] ?? null;
      const merged = isCredentials
        ? mergeInherited(current, incoming, baseline)
        : mergePatchLayers(current, incoming, baseline);
      next.files = { ...next.files, [key]: merged.baseline };
      report.overrides += merged.overrides;
      await save(target, inheritableYamlText(merged.value));
    }
    for (const change of changes) {
      aborted(context.signal);
      await write(change.file, change.content, change.previous);
      await execute('chmod', ['600', change.file]);
    }
    next.date = report.date;
    await write(stateFile, JSON.stringify(next, null, 2), stateText);
    const preferences = await this.stored();
    await atomic(this.preferences, { ...preferences, options, applied: report });
    return report;
  }
}

/** Re-exported for callers that only import the inheritance module. */
export type { JobOwner };
