import { RefreshCw } from 'lucide-react';
import type { EngineController } from '../../lib/engine/useEngine';
import { executionCommandLabels } from '../../lib/executionLabels';
import { useI18n } from '../../lib/i18n';

export function EngineBanner({
  engine,
  onSettings,
}: {
  engine: EngineController;
  onSettings: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="engine-banner border-b border-solid border-b-line flex gap-2.5 flex-wrap items-center text-[12px] shrink-0 max-h-[30vh] overflow-auto px-6 py-3">
      <span
        className={`dot inline-block w-1.5 h-1.5 bg-surface-raised rounded-full shrink-0 ${engine.info ? 'green' : 'amber'}`}
      />
      <span>
        {engine.info
          ? t('execution.engineVersionStatus', {
              version: engine.info.version,
              status: engine.error
                ? t('execution.unavailableCachedData')
                : engine.syncing
                  ? t('execution.syncing')
                  : t('resources.connected'),
            })
          : t('execution.connectAnEngineToExecuteYourWorkflows')}
      </span>
      <button
        type="button"
        className="text-button"
        onClick={engine.info ? () => void engine.refresh() : onSettings}
      >
        {engine.info ? (
          <>
            <RefreshCw size={14} />
            {t('common.refresh')}
          </>
        ) : (
          t('execution.connectInSettings')
        )}
      </button>
      {engine.error ? (
        <p
          className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
          role="alert"
        >
          {engine.error}
          {engine.info ? ` ${t('execution.showingTheLastReceivedData')}` : ''}
        </p>
      ) : null}
      {engine.pending.length ? (
        <div className="pending-operations bg-surface border border-solid border-line p-3">
          <strong>
            {t('execution.countCommandSAwaitingConfirmation', { count: engine.pending.length })}
          </strong>
          <p>{t('execution.reconcileTheseSavedCommandsWithTheirOriginalOperation')}</p>
          {engine.pending.map((operation) => (
            <button
              type="button"
              className="button small-button text-[11px] min-h-8 px-3 py-1.75"
              key={operation.id}
              onClick={() => {
                void engine.command(operation.request).catch(() => {});
              }}
            >
              {t('execution.reconcileOperationId', {
                operation: t(executionCommandLabels[operation.request.op] ?? operation.request.op),
                id: operation.id.slice(0, 8),
              })}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
