import path from 'node:path';
import { ensure, text } from './errors.js';
import { t } from './i18n/index.js';

/** Normalize and validate an absolute Linux path. */
export function linuxPath(value: unknown): string {
  text(value, 'Linux path');
  ensure((value as string).startsWith('/'), 'INVALID_PATH', 'paths.linuxAbsolute');
  return path.posix.normalize(value as string);
}

/** Validate a WSL distribution name supplied by the UI or configuration. */
export function distroName(value: unknown): string {
  text(value, 'distro', 128);
  ensure(
    !/[\\/\r\n\x00-\x1f]/.test(value as string) && !(value as string).startsWith('-'),
    'INVALID_DISTRO',
    'paths.invalidDistro',
  );
  return value as string;
}

/** Parsed `\\wsl.localhost\<distro>\...` reference. */
export interface WslUncPath {
  distro: string;
  path: string;
}

/** Parse a WSL UNC path, or return null when the value is not one. */
export function parseWslUnc(value: string): WslUncPath | null {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i.exec(value);
  if (!match) return null;
  const distro = match[1] as string;
  return {
    distro: distroName(distro),
    path: path.posix.normalize('/' + (match[2] ?? '').replaceAll('\\', '/')),
  };
}

/** Render an absolute Linux path as the Windows UNC path for that distribution. */
export function toWslUnc(value: string, distro: string): string {
  const normalized = linuxPath(value);
  ensure(
    !/[<>:"|?*\x00-\x1f\\]/.test(normalized),
    'UNREPRESENTABLE_PATH',
    'paths.unrepresentable',
  );
  return `\\\\wsl.localhost\\${distroName(distro)}${normalized.replaceAll('/', '\\')}`;
}

/**
 * Fast default-mount conversion (`C:\Work` -> `/mnt/c/Work`).
 * Runtime conversions use the distribution's own `wslpath`.
 */
export function windowsToLinux(value: string, distro?: string, mountRoot = '/mnt'): string {
  text(value, 'Windows path');
  const unc = parseWslUnc(value);
  if (unc) {
    ensure(
      !distro || unc.distro.toLowerCase() === distro.toLowerCase(),
      'DISTRO_MISMATCH',
      'paths.distroMismatch',
    );
    return unc.path;
  }
  ensure(/^[A-Za-z]:[\\/]/.test(value), 'INVALID_PATH', 'paths.windowsAbsolute');
  const normalized = path.win32.normalize(value);
  const converted = `${mountRoot}/${(normalized[0] as string).toLowerCase()}/${normalized
    .slice(3)
    .replaceAll('\\', '/')}`.replace(/\/$/, '');
  return converted || '/';
}

/** One row of `wsl.exe --list --verbose`. */
export interface DistroInfo {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

/** Parse localized `wsl.exe --list --verbose` output (UTF-16LE or UTF-8). */
export function parseDistros(buffer: Buffer | string): DistroInfo[] {
  const raw = Buffer.isBuffer(buffer)
    ? buffer.toString(buffer.includes(0) ? 'utf16le' : 'utf8')
    : String(buffer).replaceAll('\0', '');
  const rows: DistroInfo[] = [];
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(\*)?\s*(.+?)\s{2,}(\S+)\s+(1|2)\s*$/.exec(line);
    if (!match || /^docker-desktop(?:-data)?$/i.test(match[2] as string)) continue;
    rows.push({
      name: match[2] as string,
      state: match[3] as string,
      version: Number(match[4]),
      isDefault: !!match[1],
    });
  }
  return rows;
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Localized diagnostic for a failed path conversion. */
export function pathConversionError(detail: string): string {
  return t('worker.pathConversionFailed', { error: detail });
}
