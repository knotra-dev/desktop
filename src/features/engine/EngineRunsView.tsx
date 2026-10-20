import { Play, Search } from 'lucide-react';
import { useState } from 'react';
import { Empty, Status, time } from '../../components/ui';
import type { EngineController } from '../../lib/engine/useEngine';
import { executionStatusLabels } from '../../lib/executionLabels';
import { useI18n } from '../../lib/i18n';
import { EngineRunDetail } from './EngineRunDetail';

export function EngineRunsView({
  engine,
  activeId,
  onSelect,
  onReview,
}: {
  engine: EngineController;
  activeId?: string;
  onSelect: (id?: string) => void;
  onReview: () => void;
}) {
  const { t, locale } = useI18n();
  const run = engine.runs.find((run) => run.id === activeId);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  if (run)
    return (
      <EngineRunDetail
        key={run.id}
        run={run}
        engine={engine}
        onBack={() => onSelect(undefined)}
        onReview={onReview}
      />
    );
  const ordered = [...engine.runs].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id),
  );
  const filtered = ordered.filter(
    (run) =>
      (status === 'all' || status === run.status) &&
      `${run.id} ${run.title}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="page pb-8.75 min-h-full">
      <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <h1>{t('execution.engineRuns')}</h1>
          <p>{t('execution.executionStateBelongsToTheEngineClosingThis')}</p>
        </div>
      </header>
      <div className="list-toolbar runs-toolbar flex items-center justify-start gap-3 mb-5">
        <label className="search-field flex items-center gap-3 text-secondary border border-solid border-line rounded-[16px] w-100 bg-surface px-4.5 py-0">
          <Search size={16} />
          <input
            aria-label={t('execution.searchEngineRuns')}
            placeholder={t('execution.searchRuns2')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="status-filter">
          <select
            aria-label={t('execution.filterEngineRuns')}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {[
              'all',
              'pending',
              'ready',
              'running',
              'retry_wait',
              'waiting_human',
              'waiting_resolution',
              'succeeded',
              'failed',
              'cancelled',
            ].map((status) => (
              <option value={status} key={status}>
                {t(executionStatusLabels[status] ?? status)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {filtered.length ? (
        <div className="run-table border border-solid border-line rounded-[20px] overflow-hidden bg-surface">
          <div className="table-header grid grid-cols-[minmax(230px,_1.8fr)_1fr_1fr_100px] gap-5 items-center pt-6.5 pb-5 w-full text-left text-[12px] tracking-[0] text-muted bg-transparent [border-bottom:0] px-5.25">
            <span>{t('execution.pipelineRun')}</span>
            <span>{t('execution.status')}</span>
            <span>{t('execution.started')}</span>
            <span>{t('execution.profile')}</span>
          </div>
          {filtered.map((run) => (
            <button
              type="button"
              className="run-table-row grid grid-cols-[minmax(230px,_1.8fr)_1fr_1fr_100px] gap-5 items-center w-full text-left [border-bottom:0] px-5.25 py-6.5"
              key={run.id}
              onClick={() => onSelect(run.id)}
            >
              <span className="run-name flex items-center gap-3.25">
                <Play size={17} />
                <span>
                  <strong>{run.title}</strong>
                  <small>{run.id}</small>
                </span>
              </span>
              <Status status={run.status} />
              <span className="small muted text-[11px] text-muted">
                {time(run.createdAt, locale)}
              </span>
              <span className="small text-[11px]">{run.profile}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty icon={<Play />} title={t('execution.noEngineRuns')}>
          {t('execution.startAWorkflowFromItsEditorAfterConnecting')}
        </Empty>
      )}
    </section>
  );
}
