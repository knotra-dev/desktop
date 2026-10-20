import { ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Status, time } from '../../components/ui';
import { engineCall, engineError } from '../../lib/engine/client';
import { compareRuns, type ValueChange } from '../../lib/engine/history';
import { durationLabel } from '../../lib/engine/observation';
import type { EngineInstance, EngineRun, Page } from '../../lib/engine/types';
import { useI18n } from '../../lib/i18n';
import { HistoryPreview } from './HistoryPreview';

function Changes({ label, changes }: { label: string; changes: ValueChange[] }) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(30);
  return (
    <details
      className="history-change-section border border-solid border-line rounded-[9px] p-3.5"
      aria-label={label}
      open={changes.length > 0}
    >
      <summary>
        {label}
        <span>{changes.length}</span>
      </summary>
      {!changes.length ? (
        <p className="muted text-muted">{t('history.unchanged')}</p>
      ) : (
        changes.slice(0, limit).map((change) => (
          <details
            className="history-value-change mt-3 pt-2.5 border-t border-solid border-t-line"
            key={change.key}
          >
            <summary>{change.key}</summary>
            <div className="history-diff grid grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)] gap-3.5">
              <div>
                <h4>{t('history.before')}</h4>
                <HistoryPreview value={change.before} />
              </div>
              <div>
                <h4>{t('history.after')}</h4>
                <HistoryPreview value={change.after} />
              </div>
            </div>
          </details>
        ))
      )}
      {changes.length > limit && (
        <button
          type="button"
          className="button small text-[11px]"
          onClick={() => setLimit((value) => value + 30)}
        >
          {t('history.showMore')}
        </button>
      )}
    </details>
  );
}

export function EngineCompareView({
  run,
  runs,
  connected,
}: {
  run: EngineRun;
  runs: EngineRun[];
  connected: boolean;
}) {
  const { t, locale } = useI18n();
  const candidates = useMemo(
    () =>
      runs
        .filter(
          (item) => item.id !== run.id && Date.parse(item.createdAt) <= Date.parse(run.createdAt),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [runs, run.id, run.createdAt],
  );
  const [selected, setSelected] = useState('');
  const [before, setBefore] = useState<EngineRun>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(100);
  const revision = useRef(0);
  useEffect(() => {
    const generation = ++revision.current;
    setError('');
    setBusy(false);
    if (!connected) return;
    setBefore(undefined);
    if (selected) {
      setBusy(true);
      void engineCall<{ run: EngineRun }>({ op: 'run', runId: selected })
        .then((result) => {
          if (generation === revision.current) setBefore(result.run);
        })
        .catch((cause) => {
          if (generation === revision.current) setError(engineError(cause).message);
        })
        .finally(() => {
          if (generation === revision.current) setBusy(false);
        });
    }
    return () => {
      revision.current++;
    };
  }, [selected, connected]);
  async function loadBaselineInstances() {
    if (!connected || !before?.instancesNextCursor || busy) return;
    const generation = revision.current;
    const cursor = before.instancesNextCursor;
    setBusy(true);
    setError('');
    try {
      const page = await engineCall<Page<EngineInstance>>({
        op: 'instances',
        runId: before.id,
        cursor,
      });
      if (generation !== revision.current) return;
      setBefore((current) =>
        current?.id === before.id && current.instancesNextCursor === cursor
          ? {
              ...current,
              instances: [...current.instances, ...page.items],
              instancesNextCursor: page.nextCursor ?? undefined,
            }
          : current,
      );
    } catch (cause) {
      if (generation === revision.current) setError(engineError(cause).message);
    } finally {
      if (generation === revision.current) setBusy(false);
    }
  }
  const comparison = useMemo(() => (before ? compareRuns(before, run) : undefined), [before, run]);
  const rows = comparison?.instances ?? [];
  return (
    <section
      className="history-view min-w-0 flex flex-col gap-3.5"
      aria-label={t('history.compare')}
    >
      <div className="history-toolbar flex items-center gap-3 justify-between">
        <div>
          <strong>{t('history.compare')}</strong>
          <p>{t('history.compareExplanation')}</p>
        </div>
      </div>
      <label className="history-scope flex items-center gap-3">
        {t('history.baseline')}
        <select
          aria-label={t('history.baseline')}
          value={selected}
          onChange={(event) => {
            revision.current++;
            setBefore(undefined);
            setSelected(event.target.value);
            setLimit(100);
          }}
          disabled={!connected}
        >
          <option value="">{t('history.chooseRun')}</option>
          {candidates.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title} · {time(item.createdAt, locale)} · {item.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      {before?.instancesNextCursor && (
        <button
          type="button"
          className="button"
          disabled={!connected || busy}
          onClick={() => void loadBaselineInstances()}
        >
          {t('history.loadMoreBaselineInstances')}
        </button>
      )}
      {!connected && (
        <p className="history-notice border border-solid border-line bg-surface-raised rounded-[7px] text-[12px] wrap-anywhere px-3 py-2.5">
          {t('history.connect')}
        </p>
      )}
      {!candidates.length && <p className="muted text-muted">{t('history.noEarlierRuns')}</p>}
      {busy && <p role="status">{t('history.loading')}</p>}
      {error && (
        <p
          className="history-notice border border-solid border-line bg-surface-raised rounded-[7px] text-[12px] wrap-anywhere px-3 py-2.5"
          role="alert"
        >
          {error}
        </p>
      )}
      {before && comparison && (
        <>
          <div className="history-comparison-heading grid grid-cols-[1fr_auto_1fr] gap-5 items-center border border-solid border-line rounded-[10px] p-4">
            <div>
              <small>{t('history.before')}</small>
              <strong>{before.title}</strong>
              <span>{time(before.createdAt, locale)}</span>
              <Status status={before.status} />
            </div>
            <ArrowRight size={18} />
            <div>
              <small>{t('history.after')}</small>
              <strong>{run.title}</strong>
              <span>{time(run.createdAt, locale)}</span>
              <Status status={run.status} />
            </div>
          </div>
          <Changes label={t('history.prompts')} changes={comparison.prompts} />
          <Changes label={t('history.source')} changes={comparison.source} />
          <details className="history-change-section border border-solid border-line rounded-[9px] p-3.5">
            <summary>
              {t('history.files')}
              <span>{comparison.files.length}</span>
            </summary>
            <p className="muted text-muted">{t('history.fileExplanation')}</p>
            {comparison.files.length ? (
              <ul>
                {comparison.files.map((file) => (
                  <li key={file.key}>
                    {file.key} ·{' '}
                    {t(
                      file.before === undefined
                        ? 'history.added'
                        : file.after === undefined
                          ? 'history.removed'
                          : 'history.modified',
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted text-muted">{t('history.unchanged')}</p>
            )}
          </details>
          <Changes label={t('history.inputs')} changes={comparison.inputs} />
          <Changes label={t('history.inputArtifacts')} changes={comparison.inputArtifacts} />
          <Changes label={t('history.outputs')} changes={comparison.outputs} />
          {!comparison.instancesComplete ? (
            <p role="status">{t('history.instancesIncomplete')}</p>
          ) : (
            <details
              className="history-change-section border border-solid border-line rounded-[9px] p-3.5"
              open
            >
              <summary>
                {t('history.nodeComparison')}
                <span>
                  {t('history.changedCount', {
                    count: rows.filter((row) => row.changed).length,
                    total: rows.length,
                  })}
                </span>
              </summary>
              <p className="muted text-muted">{t('history.nodeExplanation')}</p>
              <div className="history-node-table">
                <div className="history-node-header grid grid-cols-[minmax(160px,_1.6fr)_minmax(90px,_1fr)_minmax(90px,_1fr)] gap-3.5 text-muted text-[11px] px-2 py-3">
                  <span>{t('history.node')}</span>
                  <span>{t('history.before')}</span>
                  <span>{t('history.after')}</span>
                </div>
                {rows.slice(0, limit).map((row) => (
                  <div
                    className={`history-node-row grid grid-cols-[minmax(160px,_1.6fr)_minmax(90px,_1fr)_minmax(90px,_1fr)] gap-3.5 border-t border-solid border-t-line px-2 py-3 ${row.changed ? 'history-node-changed bg-[rgb(var(--accent-rgb)_/_0.035)]' : ''}`}
                    key={`${row.key}:${row.before?.id ?? ''}:${row.after?.id ?? ''}`}
                  >
                    <div>
                      <strong>{row.after?.nodeId ?? row.before?.nodeId}</strong>
                      <small>{row.key}</small>
                      {row.ambiguous && <small>{t('history.ambiguous')}</small>}
                    </div>
                    <div>
                      {row.before ? (
                        <>
                          <Status status={row.before.status} />
                          <span>{durationLabel(row.beforeDuration)}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </div>
                    <div>
                      {row.after ? (
                        <>
                          <Status status={row.after.status} />
                          <span>{durationLabel(row.afterDuration)}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {rows.length > limit && (
                <button
                  type="button"
                  className="button small text-[11px]"
                  onClick={() => setLimit((value) => value + 100)}
                >
                  {t('history.showMore')}
                </button>
              )}
            </details>
          )}
        </>
      )}
    </section>
  );
}
