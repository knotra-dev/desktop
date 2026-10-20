import { duration, durationLabel } from '../../../lib/engine/observation';
import { type EngineInstance, type EngineRun, terminal } from '../../../lib/engine/types';
import { useI18n } from '../../../lib/i18n';

export function ExecutionWaterfall({
  run,
  now,
  selectedInstanceId,
  onSelectInstance,
}: {
  run: EngineRun;
  now: number;
  selectedInstanceId?: string;
  onSelectInstance: (instance: EngineInstance) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="execution-waterfall shrink-0 max-h-52.5 flex flex-col border-t border-solid border-t-line bg-surface-raised px-3.75 py-3">
      <div className="execution-waterfall-heading flex justify-between mb-2.5 text-[10px]">
        <strong>{t('observe.timing')}</strong>
        <span>
          {durationLabel(duration(run.createdAt, terminal(run.status) ? run.updatedAt : now))}
        </span>
      </div>
      <div className="execution-waterfall-rows overflow-auto">
        {run.instances
          .filter((instance) => instance.startedAt)
          .map((instance) => {
            const total = Math.max(
              1,
              duration(run.createdAt, terminal(run.status) ? run.updatedAt : now) ?? 1,
            );
            const start = duration(run.createdAt, instance.startedAt) ?? 0;
            const length =
              duration(
                instance.startedAt,
                instance.finishedAt ??
                  (terminal(instance.status) ? (instance.updatedAt ?? run.updatedAt) : now),
              ) ?? 0;
            return (
              <button
                type="button"
                key={instance.id}
                className={`execution-waterfall-row grid grid-cols-[140px_1fr_60px] items-center gap-3 w-full text-left text-[10px] rounded-[4px] px-0.75 py-1.25 ${instance.id === selectedInstanceId ? 'active' : ''}`}
                onClick={() => onSelectInstance(instance)}
                title={`${instance.nodeId} · ${instance.id}`}
              >
                <span>
                  {instance.nodeId}
                  {instance.iterationIndex === undefined ? '' : ` [${instance.iterationIndex + 1}]`}
                </span>
                <div className="execution-waterfall-track h-3.5 relative [background:repeating-linear-gradient(90deg,_var(--border)_0_1px,_transparent_1px_25%)]">
                  <i
                    className={`state-${instance.status}`}
                    style={{
                      left: `${Math.min(99, (start / total) * 100)}%`,
                      width: `${Math.max(1, Math.min(100 - (start / total) * 100, (length / total) * 100))}%`,
                    }}
                  />
                </div>
                <small>{durationLabel(length)}</small>
              </button>
            );
          })}
        {!run.instances.some((instance) => instance.startedAt) ? (
          <p className="muted small text-[11px] text-muted">{t('observe.noTiming')}</p>
        ) : null}
      </div>
    </div>
  );
}
