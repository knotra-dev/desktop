import { invoke } from '@tauri-apps/api/core';
import { unbase64 } from './bytes';
import { type Locale, normalizeLocale, preferredLocale } from './i18n';
import { desktop } from './native';
import type { Theme } from './theme';
import { type DemoRun, record, type Workspace } from './types';
import { validPath } from './validation';

export const STARTER_REVISION = 5;

const KEY = 'knotra.workspace.v1';
const WORKSPACE_BUSY =
  'This workspace is already open in another browser tab. Close that tab and retry.';
// Fast Refresh can replace this module while the tab still owns its browser lock.
const workspaceSession: { browserOpen: boolean; initialLoad?: Promise<State> } = import.meta.hot
  ?.data.workspaceSession ?? { browserOpen: false };
if (import.meta.hot) import.meta.hot.data.workspaceSession = workspaceSession;
const foldPath = (path: string) => path.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

export interface State {
  version: 1;
  starterRevision?: 1 | 2 | 3 | 4 | 5;
  workspaces: Workspace[];
  runs: DemoRun[];
  activeId: string;
  engineUrl: string;
  engineMode?: 'local' | 'manual';
  compact: boolean;
  theme: Theme;
  locale: Locale;
}

export function freshState(): State {
  const locale = preferredLocale();
  return {
    version: 1,
    starterRevision: STARTER_REVISION,
    workspaces: [],
    runs: [],
    activeId: '',
    engineUrl: 'http://127.0.0.1:8787',
    engineMode: 'local',
    compact: false,
    theme: 'dark',
    locale,
  };
}

export function loadState(): State {
  const raw = localStorage.getItem(KEY);
  return raw === null ? freshState() : readBackup(raw);
}

// Existing templates may be user-created, so upgrades preserve every draft and history.
export async function migrateStarters(state: State): Promise<State> {
  if (state.starterRevision === STARTER_REVISION) return state;
  return { ...state, starterRevision: STARTER_REVISION };
}

let writes: Promise<void> = Promise.resolve();

export function loadWorkspace(): Promise<State> {
  workspaceSession.initialLoad ??= readWorkspace();
  return workspaceSession.initialLoad;
}

async function readWorkspace(): Promise<State> {
  if (!desktop) {
    await new Promise<void>((resolve, reject) => {
      if (!navigator.locks) {
        reject(
          new Error(
            'This browser cannot safely lock the workspace. Use a browser with Web Locks support.',
          ),
        );
        return;
      }

      void navigator.locks
        .request(KEY, { ifAvailable: true }, (lock) => {
          if (!lock) {
            reject(new Error(WORKSPACE_BUSY));
            return;
          }

          workspaceSession.browserOpen = true;
          resolve();
          // The browser releases this lock when the tab closes; saves remain synchronous.
          return new Promise<void>(() => {});
        })
        .catch(reject);
    });
    const loaded = loadState();
    const migrated = await migrateStarters(loaded);
    if (migrated !== loaded) await saveState(migrated);

    return migrated;
  }

  const saved = await invoke<State | null>('workspace_load');
  if (saved) {
    const loaded = readBackup(JSON.stringify(saved));
    const migrated = await migrateStarters(loaded);
    if (migrated !== loaded) await saveState(migrated);
    return migrated;
  }

  const legacy = localStorage.getItem(KEY);
  const migrated = await migrateStarters(legacy === null ? freshState() : readBackup(legacy));
  await invoke('workspace_save', { value: migrated });

  return migrated;
}

export function saveState(state: State): Promise<void> {
  if (!desktop) {
    try {
      if (!workspaceSession.browserOpen) throw new Error(WORKSPACE_BUSY);

      localStorage.setItem(KEY, JSON.stringify(state));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }
  const value = JSON.parse(JSON.stringify(state));
  const next = writes.catch(() => {}).then(() => invoke<void>('workspace_save', { value }));
  writes = next;

  return next;
}

export function flushWorkspace(): Promise<void> {
  return writes;
}

export function readBackup(text: string): State {
  if (new TextEncoder().encode(text).length > 96 * 1024 * 1024)
    throw new Error('Workspace backup exceeds 96 MiB.');

  const value = JSON.parse(text);
  if (value?.version !== 1 || !Array.isArray(value.workspaces) || !Array.isArray(value.runs))
    throw new Error('Unsupported workspace backup.');

  const ids = new Set<string>();
  for (const workspace of value.workspaces) {
    if (
      !workspace ||
      typeof workspace.id !== 'string' ||
      !workspace.id ||
      ids.has(workspace.id) ||
      typeof workspace.source !== 'string' ||
      typeof workspace.savedSource !== 'string' ||
      typeof workspace.entrypoint !== 'string' ||
      !Array.isArray(workspace.files) ||
      typeof workspace.updatedAt !== 'string'
    )
      throw new Error('Invalid pipeline draft in backup.');

    ids.add(workspace.id);
    if (
      !workspace.files.every(
        (file: unknown) =>
          file &&
          typeof file === 'object' &&
          typeof (file as { path: unknown }).path === 'string' &&
          typeof (file as { content: unknown }).content === 'string',
      )
    )
      throw new Error('Invalid supporting file in backup.');

    const paths = new Set([foldPath(workspace.entrypoint)]);
    let size = new TextEncoder().encode(workspace.source).length;
    if (!validPath(workspace.entrypoint) || workspace.files.length > 511)
      throw new Error('Invalid package paths or file count in backup.');

    for (const file of workspace.files) {
      if (!validPath(file.path) || paths.has(foldPath(file.path)))
        throw new Error('Duplicate or invalid package path in backup.');

      paths.add(foldPath(file.path));
      size += unbase64(file.content).length;
    }
    if (size > 64 * 1024 * 1024) throw new Error('Package in backup exceeds 64 MiB.');
    if (
      workspace.positions &&
      !Object.values(workspace.positions).every(
        (position) =>
          position &&
          typeof position === 'object' &&
          Number.isFinite((position as { x: number }).x) &&
          Number.isFinite((position as { y: number }).y),
      )
    )
      throw new Error('Invalid canvas positions in backup.');
  }
  const runIds = new Set<string>();
  for (const run of value.runs) {
    if (
      !run ||
      !['id', 'workspaceId', 'title', 'topic', 'createdAt', 'updatedAt', 'source'].every(
        (key) => typeof run[key] === 'string',
      ) ||
      runIds.has(run.id) ||
      !['running', 'waiting_human', 'succeeded', 'failed', 'cancelled'].includes(run.status) ||
      !Array.isArray(run.files) ||
      !Array.isArray(run.events) ||
      !Array.isArray(run.artifacts) ||
      (run.requestId !== undefined && typeof run.requestId !== 'string') ||
      !run.nodes ||
      !run.inputs ||
      !run.outputs
    )
      throw new Error('Invalid demo history in backup.');
    if (
      !run.events.every((event: unknown) => {
        const value = record(event);
        return (
          ['id', 'at', 'message'].every((key) => typeof value[key] === 'string') &&
          (value.node === undefined || typeof value.node === 'string')
        );
      }) ||
      !run.artifacts.every((artifact: unknown) => {
        const value = record(artifact);
        return (
          ['id', 'name', 'content', 'sha256', 'mediaType'].every(
            (key) => typeof value[key] === 'string',
          ) &&
          typeof value.size === 'number' &&
          Number.isSafeInteger(value.size) &&
          value.size >= 0
        );
      })
    )
      throw new Error('Invalid demo outputs or events in backup.');

    runIds.add(run.id);
  }
  const engineUrl = typeof value.engineUrl === 'string' ? value.engineUrl : 'http://127.0.0.1:8787';
  const address = new URL(engineUrl);
  if (
    !['http:', 'https:'].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('Invalid engine address in backup.');

  return {
    version: 1,
    ...([1, 2, 3, 4, 5].includes(value.starterRevision)
      ? { starterRevision: value.starterRevision as 1 | 2 | 3 | 4 | 5 }
      : {}),
    workspaces: value.workspaces,
    runs: value.runs,
    activeId: ids.has(value.activeId) ? value.activeId : (value.workspaces[0]?.id ?? ''),
    engineUrl,
    ...(value.engineMode === 'local' || value.engineMode === 'manual'
      ? { engineMode: value.engineMode }
      : !['localhost', '[::1]'].includes(address.hostname) &&
          !/^127(?:\.\d{1,3}){3}$/.test(address.hostname)
        ? { engineMode: 'manual' as const }
        : {}),
    compact: value.compact === true,
    theme: value.theme === 'light' ? 'light' : 'dark',
    locale: normalizeLocale(value.locale),
  };
}
