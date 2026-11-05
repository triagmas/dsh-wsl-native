import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  StateDot,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineMedium,
  IconChevronRightOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ct } from './i18n/client.js';
import type { DirectoryEntry, DirectoryListing, PanelApi } from './client-types.js';

/** Badge severity understood by `StateDot`. */
export type BadgeState = 'idle' | 'ongoing' | 'done' | 'error';

/** Ignored: `IconChevronDownOutlineRegular` is imported for parity with the panel. */
void IconChevronDownOutlineRegular;

/** Terminal glyph used for WSL affordances. */
export function TerminalIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </svg>
  );
}

/** Monitor glyph used for Windows affordances. */
export function SystemIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2.5" />
      <path d="M8 21h8m-4-4v4" />
    </svg>
  );
}

/** External-link glyph. */
export function OpenIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4h6v6m0-6L10 14m0-10H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

/** Small state badge with a coloured dot. */
export function Badge({ state = 'idle', children }: { state?: BadgeState; children?: React.ReactNode }) {
  return (
    <span className="dsh-wsl-badge">
      <StateDot state={state} size={state === 'ongoing' ? 12 : 7} />
      {children}
    </span>
  );
}

/** One distro as reported by the host. */
export interface DistroInfo {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

/** Fill in the missing parts of an environment selection. */
export function normalized(
  settings: { distro?: string; user?: string; directory?: string },
  distros: readonly DistroInfo[] = [],
): { distro: string; user: string; directory: string } {
  return {
    distro: settings.distro || distros.find((distro) => distro.isDefault)?.name || distros[0]?.name || '',
    user: settings.user || '',
    directory: settings.directory || '',
  };
}

/** Parent of a POSIX path, keeping `/` as its own parent. */
export function parentPath(path: string): string {
  return path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
}

/** Join a POSIX path with one entry name. */
export function joinPath(path: string, name: string): string {
  return `${path.replace(/\/+$/, '')}/${name}`;
}

/** Translate the filesystem errors the picker can hit into readable text. */
export function directoryError(error: Error): string {
  if (/ENOENT/.test(error.message)) return ct('ui.picker.error.missing');
  if (/EACCES|EPERM/.test(error.message)) return ct('ui.picker.error.permission');
  if (/ENOTDIR/.test(error.message)) return ct('ui.picker.error.notDirectory');
  return error.message;
}

/** Props for the Linux directory picker. */
export interface DirectoryPickerProps {
  api: PanelApi;
  distro: string;
  user: string;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
  allowCreate?: boolean;
}

/** Browse and create Linux directories through the host bridge. */
export function DirectoryPicker({ api, distro, user, initialPath, onClose, onSelect, allowCreate = false }: DirectoryPickerProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState(initialPath);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [folderName, setFolderName] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(
    async (destination: string | null, offset = 0, showHidden = false): Promise<void> => {
      const id = ++request.current;
      setLoading(true);
      setError('');
      try {
        const home = destination ? null : ((await api('connect', { distro, user })) as { home: string });
        const result = (await api('browse', {
          distro,
          user,
          path: destination ?? home?.home ?? '',
          offset,
          hidden: showHidden,
        })) as DirectoryListing;
        if (id !== request.current) return;
        setListing((previous) => ({
          ...result,
          entries: offset ? [...(previous?.entries ?? []), ...result.entries] : result.entries,
        }));
        setPath(result.path);
      } catch (cause) {
        if (id === request.current) setError(directoryError(cause as Error));
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [api, distro, user],
  );

  useEffect(() => {
    void load(initialPath);
    return () => {
      request.current++;
    };
  }, [load, initialPath]);

  const folders = (listing?.entries ?? [])
    .filter((entry) => entry.type === 'directory' || entry.type === 'symlink')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const navigate = (destination: string): void => {
    void load(destination, 0, hidden);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={ct('ui.picker.title')}
      closeLabel={ct('ui.picker.closeLabel')}
      description={ct('ui.picker.description', { distro })}
      className="dsh-wsl-picker"
      contentClassName="dsh-wsl-picker-content"
      footer={
        <>
          <Button onClick={onClose}>{ct('ui.common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={loading || !listing || !!error || path !== listing.path}
            onClick={() => listing && onSelect(listing.path)}
          >
            {ct('ui.picker.select')}
          </Button>
        </>
      }
    >
      <form
        className="dsh-wsl-pathbar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(path);
        }}
      >
        <Button
          variant="outline"
          title={ct('ui.picker.up')}
          aria-label={ct('ui.picker.up')}
          disabled={loading || !listing || listing.path === '/'}
          icon={<IconChevronLeftOutlineMedium />}
          onClick={() => listing && navigate(parentPath(listing.path))}
        />
        <Input
          aria-label={ct('ui.picker.pathLabel')}
          data-modal-autofocus
          value={path}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPath(event.target.value)}
          spellCheck={false}
          className="dsh-wsl-pathinput"
          placeholder="/home"
        />
        <Button variant="outline" type="submit" disabled={loading || !path.trim()}>
          {ct('ui.picker.go')}
        </Button>
      </form>
      <div className="dsh-wsl-folder-meta">
        <span>
          {ct('ui.picker.folderCount', { count: folders.length })}
          {listing?.nextOffset != null ? ` · ${ct('ui.picker.more')}` : ''}
        </span>
        <label>
          <input
            type="checkbox"
            checked={hidden}
            disabled={loading}
            onChange={(event) => {
              const next = event.target.checked;
              setHidden(next);
              void load(listing?.path ?? path, 0, next);
            }}
          />
          {ct('ui.picker.showHidden')}
        </label>
      </div>
      {allowCreate ? (
        <div className="dsh-wsl-folder-create">
          {folderName === null ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || !listing || !!error}
              onClick={() => setFolderName('')}
            >
              {ct('ui.picker.newFolder')}
            </Button>
          ) : (
            <form
              className="dsh-wsl-pathbar"
              onSubmit={(event) => {
                event.preventDefault();
                if (loading || !folderName.trim() || !listing) return;
                setLoading(true);
                setError('');
                void (async () => {
                  try {
                    const result = (await api('directory/create', {
                      distro,
                      user,
                      parent: listing.path,
                      name: folderName.trim(),
                    })) as { path: string };
                    setFolderName(null);
                    await load(result.path, 0, hidden);
                  } catch (cause) {
                    setError((cause as Error).message);
                    setLoading(false);
                  }
                })();
              }}
            >
              <Input
                aria-label={ct('ui.picker.folderNameLabel')}
                value={folderName}
                placeholder={ct('ui.picker.folderName')}
                maxLength={255}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setFolderName(event.target.value)}
              />
              <Button type="submit" disabled={loading || !folderName.trim()}>
                {ct('ui.picker.create')}
              </Button>
              <Button disabled={loading} onClick={() => setFolderName(null)}>
                {ct('ui.common.cancel')}
              </Button>
            </form>
          )}
        </div>
      ) : null}
      <div className="dsh-wsl-folder-list" aria-label={ct('ui.picker.listLabel')} aria-busy={loading}>
        {error ? (
          <div className="dsh-wsl-inline-error" role="alert">
            {error}
            <Button size="sm" onClick={() => navigate(path)}>
              {ct('ui.common.retry')}
            </Button>
          </div>
        ) : null}
        {!error &&
          folders.map((entry: DirectoryEntry) => (
            <button
              type="button"
              className="dsh-wsl-folder"
              disabled={loading}
              key={entry.name}
              onClick={() => listing && navigate(joinPath(listing.path, entry.name))}
            >
              <IconFolderCloseRegular size={18} />
              <span>{entry.name}</span>
              {entry.type === 'symlink' ? <small>{ct('ui.picker.symlink')}</small> : null}
              <IconChevronRightOutlineRegular size={14} />
            </button>
          ))}
        {loading ? (
          <div className="dsh-wsl-empty" role="status">
            <StateDot state="ongoing" />
            {ct('ui.picker.loading')}
          </div>
        ) : null}
        {!loading && !error && !folders.length ? (
          <div className="dsh-wsl-empty">
            <IconFolderOpenOutlineRegular size={28} />
            <span>{listing?.nextOffset != null ? ct('ui.picker.emptyPage') : ct('ui.picker.empty')}</span>
          </div>
        ) : null}
        {!loading && !error && listing?.nextOffset != null ? (
          <Button className="dsh-wsl-load-more" onClick={() => void load(listing.path, listing.nextOffset ?? 0, hidden)}>
            {ct('ui.picker.loadMore')}
          </Button>
        ) : null}
      </div>
      <p className="dsh-wsl-picker-hint">
        {listing?.path ?? ct('ui.picker.choose')}
        {path !== listing?.path && listing ? ` · ${ct('ui.picker.pressGo')}` : ''}
      </p>
    </Modal>
  );
}
