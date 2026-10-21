import { useRef, useState } from 'react';
import { preferredLocale, translateMessage, useTranslation } from '../lib/i18n';
import { desktop, exportFile } from '../lib/native';
import { readBackup, STARTER_REVISION, type State, saveState } from '../lib/storage';

export function WorkspaceRecovery({
  error,
  onRestore,
}: {
  error: string;
  onRestore: (state: State) => void;
}) {
  const locale = preferredLocale();
  const t = useTranslation(locale);
  const input = useRef<HTMLInputElement>(null);
  const [candidate, setCandidate] = useState<State>();
  const [detail, setDetail] = useState(error);

  return (
    <div
      className="loading workspace-recovery text-muted flex-col gap-4.5 text-center p-10"
      role="alert"
    >
      <h1>{t('storage.loadFailed')}</h1>
      <p>{t('storage.preserved')}</p>
      <p>{translateMessage(detail, locale)}</p>
      <div className="heading-actions flex items-center gap-2.5">
        {!desktop ? (
          <button
            type="button"
            className="button"
            onClick={async () => {
              try {
                const raw = localStorage.getItem('knotra.workspace.v1');
                if (raw !== null)
                  await exportFile('knotra-workspace-original.json', raw, 'application/json');
              } catch (e) {
                setDetail(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            {t('storage.downloadOriginal')}
          </button>
        ) : null}
        <button type="button" className="button" onClick={() => input.current?.click()}>
          {t('storage.restore')}
        </button>
        <button type="button" className="button" onClick={() => location.reload()}>
          {t('common.retry')}
        </button>
      </div>
      <input
        ref={input}
        hidden
        type="file"
        accept=".json,application/json"
        aria-label={t('storage.restore')}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          try {
            if (file.size > 96 * 1024 * 1024) throw new Error('Workspace backup exceeds 96 MiB.');
            setCandidate({ ...readBackup(await file.text()), starterRevision: STARTER_REVISION });
          } catch (e) {
            setDetail(e instanceof Error ? e.message : String(e));
            setCandidate(undefined);
          }
        }}
      />
      {candidate ? (
        <>
          <p>
            {t('storage.replaceConfirm')}{' '}
            {t('pipelines.count', { count: candidate.workspaces.length })}
          </p>
          <button
            type="button"
            className="button primary"
            onClick={async () => {
              try {
                await saveState(candidate);
                onRestore(candidate);
              } catch (e) {
                setDetail(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            {t('shell.restoreBackup')}
          </button>
        </>
      ) : null}
    </div>
  );
}
