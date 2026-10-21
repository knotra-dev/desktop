import { useI18n } from '../../lib/i18n';

export function HistoryPreview({ value }: { value: unknown }) {
  const { t } = useI18n();
  if (value === undefined) return <p className="muted text-muted">{t('history.absent')}</p>;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  return (
    <>
      <pre className="history-value whitespace-pre-wrap wrap-anywhere text-[11px] leading-[1.6] bg-base border border-solid border-line rounded-[7px] max-h-90 overflow-auto p-3 m-0">
        {text.slice(0, 24 * 1024)}
      </pre>
      {text.length > 24 * 1024 && <p className="muted text-muted">{t('history.previewLimited')}</p>}
    </>
  );
}
