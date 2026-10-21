import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../lib/i18n';

export function DataBlock({
  label,
  value,
  open = false,
}: {
  label: string;
  value: unknown;
  open?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(open);
  const [full, setFull] = useState(false);
  const text = useMemo(
    () =>
      expanded && value !== undefined
        ? typeof value === 'string'
          ? value
          : JSON.stringify(value, null, 2)
        : '',
    [expanded, value],
  );

  return (
    <section className="execution-data-block mt-0 mb-3 min-w-0 mx-0">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ChevronRight size={13} className={expanded ? 'expanded' : ''} />
        <strong>{label}</strong>
      </button>
      {expanded ? (
        value === undefined ? (
          <p className="small muted text-[11px] text-muted">{t('observe.noData')}</p>
        ) : (
          <>
            <pre>{full ? text : text.slice(0, 12000)}</pre>
            {text.length > 12000 && !full ? (
              <button type="button" className="text-button" onClick={() => setFull(true)}>
                {t('observe.showFullValue')}
              </button>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}
