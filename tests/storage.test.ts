import { afterEach, describe, expect, it, vi } from 'vitest';
import { examples, fromExample } from '../src/lib/examples';
import { freshState, loadState, migrateStarters, readBackup, type State } from '../src/lib/storage';
import { legacyRun } from './fixtures/legacyRun';

const key = 'knotra.workspace.v1';
afterEach(() => vi.unstubAllGlobals());

describe('workspace loading and starter migration', () => {
  it('keeps a legacy remote engine selection manual', () => {
    const state = { ...freshState(), engineUrl: 'https://engine.example.com' };
    delete state.engineMode;
    expect(readBackup(JSON.stringify(state))).toEqual({ ...state, engineMode: 'manual' });
  });

  it.each(['local', 'manual'] as const)(
    'preserves the %s engine choice in backups',
    (engineMode) => {
      const state = { ...freshState(), engineMode };
      expect(readBackup(JSON.stringify(state))).toEqual(state);
    },
  );

  it.each(['{broken', '', JSON.stringify({ version: 1, workspaces: [{}], runs: [] })])(
    'rejects corrupt browser data without overwriting the original bytes: %s',
    (raw) => {
      const data = new Map([[key, raw]]);
      const setItem = vi.fn((name, value) => data.set(name, value));
      vi.stubGlobal('localStorage', { getItem: (name: string) => data.get(name) ?? null, setItem });
      expect(() => loadState()).toThrow();
      expect(data.get(key)).toBe(raw);
      expect(setItem).not.toHaveBeenCalled();
    },
  );

  it('starts with an empty workspace in the preferred locale', () => {
    vi.stubGlobal('navigator', { language: 'ru-RU' });
    const state = freshState();
    expect(state.locale).toBe('ru');
    expect(state.starterRevision).toBe(5);
    expect(state.workspaces).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.activeId).toBe('');
    expect(readBackup(JSON.stringify(state))).toEqual(state);
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(loadState()).toEqual(state);
  });

  it.each([undefined, 1, 2, 3, 4] as const)(
    'marks revision %s without changing pristine or customized drafts and histories',
    async (revision) => {
      const pristine = fromExample(examples.find((example) => example.id === 'research')!);
      const starter = fromExample(examples.find((example) => example.id === 'hello')!, 'ru');
      const edited = {
        ...pristine,
        id: 'customized',
        source: `${pristine.source}\n# Unsaved personal changes\n`,
        entrypoint: 'custom.yaml',
        positions: { research: { x: 120, y: 320 } },
        files: [{ path: 'notes.txt', content: 'bm90ZXM=' }],
      };
      const state: State = {
        ...freshState(),
        starterRevision: revision,
        workspaces: [pristine, starter, edited],
        runs: [legacyRun(pristine, 'Keep this history')],
        activeId: pristine.id,
      };
      if (revision === undefined) delete state.starterRevision;
      const original = JSON.stringify(state);
      const migrated = await migrateStarters(state);
      expect(migrated).toEqual({ ...state, starterRevision: 5 });
      expect(migrated.workspaces).toBe(state.workspaces);
      expect(migrated.runs).toBe(state.runs);
      expect(migrated.activeId).toBe(state.activeId);
      expect(JSON.stringify(state)).toBe(original);
      expect(await migrateStarters(migrated)).toBe(migrated);
      expect(readBackup(original)).toEqual(state);
      expect(readBackup(JSON.stringify(migrated))).toEqual(migrated);
    },
  );

  it.each([undefined, 1, 2, 3, 4, 5] as const)(
    'does not install templates in an empty revision %s workspace',
    async (revision) => {
      const state: State = { ...freshState(), starterRevision: revision };
      if (revision === undefined) delete state.starterRevision;
      const raw = JSON.stringify(state);
      expect(readBackup(raw)).toEqual(state);
      vi.stubGlobal('localStorage', { getItem: () => raw });
      expect(loadState()).toEqual(state);
      const migrated = await migrateStarters(state);
      expect(migrated).toEqual({ ...state, starterRevision: 5 });
      expect(migrated.workspaces).toBe(state.workspaces);
      expect(migrated.runs).toBe(state.runs);
      expect(migrated.activeId).toBe('');
      if (revision === 5) expect(migrated).toBe(state);
    },
  );
});

it.each([{}, [], null, 12])('rejects malformed optional demo IDs and event nodes: %j', (value) => {
  const state = freshState();
  const workspace = fromExample(examples.find((example) => example.id === 'research')!);
  state.runs = [legacyRun(workspace, 'Backup validation')];
  state.runs[0].status = 'waiting_human';
  const backup = JSON.parse(JSON.stringify(state));
  backup.runs[0].requestId = value;
  expect(() => readBackup(JSON.stringify(backup))).toThrow('Invalid demo history in backup.');
  delete backup.runs[0].requestId;
  backup.runs[0].events[0].node = value;
  expect(() => readBackup(JSON.stringify(backup))).toThrow(
    'Invalid demo outputs or events in backup.',
  );
  backup.runs[0].requestId = 'saved-request';
  backup.runs[0].events[0].node = 'research';
  expect(readBackup(JSON.stringify(backup))).toEqual(backup);
});
