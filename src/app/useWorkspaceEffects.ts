import { type Dispatch, type SetStateAction, useEffect, useRef } from 'react';
import { desktop } from '../lib/native';
import { type State, saveState } from '../lib/storage';
import type { Section } from '../lib/types';
import type { WorkspaceDialog } from './WorkspaceDialogs';

export function useWorkspacePersistence(state: State, notify: (message: string) => void) {
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const timer = setTimeout(
      () => {
        void saveState(state).catch(() =>
          notify('messages.workspaceStorageIsUnavailableExportABackupTo'),
        );
      },
      desktop ? 0 : 250,
    );
    return () => clearTimeout(timer);
  }, [state, notify]);
  useEffect(() => {
    const save = () => {
      void saveState(stateRef.current).catch(() => {});
    };
    window.addEventListener('beforeunload', save);
    return () => window.removeEventListener('beforeunload', save);
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let release: (() => void) | undefined;
    let disposed = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      const unlisten = await window.onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await saveState(stateRef.current);
          await window.destroy();
        } catch {
          notify('messages.couldNotSaveTheWorkspaceExportABackup');
        }
      });
      if (disposed) unlisten();
      else release = unlisten;
    });
    return () => {
      disposed = true;
      release?.();
    };
  }, [notify]);
  return stateRef;
}

export function useWorkspaceShortcuts(
  saveDraft: () => void,
  section: Section,
  pipelinePage: 'list' | 'editor',
  dialog: WorkspaceDialog,
  setDialog: Dispatch<SetStateAction<WorkspaceDialog>>,
  setQuery: Dispatch<SetStateAction<string>>,
) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuery('');
        setDialog('search');
      }
      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (section !== 'pipelines' || pipelinePage !== 'editor' || dialog) return;
        const field = document.activeElement;
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
          const label = field.getAttribute('aria-label');
          const start = field.selectionStart;
          const end = field.selectionEnd;
          field.blur();
          // Setup fields commit on blur. Save after React has applied that edit, preserving editor focus.
          requestAnimationFrame(() => {
            saveDraft();
            const next = field.isConnected
              ? field
              : [
                  ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
                    'input, textarea',
                  ),
                ].find((input) => label && input.getAttribute('aria-label') === label);
            next?.focus();
            if (next && start !== null && end !== null) next.setSelectionRange(start, end);
          });
        } else saveDraft();
      }
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setDialog('library');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [saveDraft, section, pipelinePage, dialog, setDialog, setQuery]);
}
