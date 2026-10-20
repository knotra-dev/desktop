import { Activity as ActivityIcon, AlertCircle, Check, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { time } from '../../../components/ui';
import { type Activity, duration, durationLabel } from '../../../lib/engine/observation';
import { useI18n } from '../../../lib/i18n';
import { record } from '../../../lib/types';
import { DataBlock } from './DataBlock';
import { eventLabel } from './eventLabel';

export function ActivityCard({ row, running }: { row: Activity; running: boolean }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  if (row.kind === 'event') {
    const event = row.events[0];
    return (
      <div className="execution-event flex gap-2.75 px-0.5 py-0.75">
        <i />
        <div>
          <strong>{eventLabel(event, t)}</strong>
          <small>{time(event.at, locale)}</small>
          <DataBlock
            label={t('observe.details')}
            value={{ type: event.type, ...record(event.data) }}
          />
        </div>
      </div>
    );
  }
  const start = record(row.started?.data);
  const end = record(row.completed?.data);
  const finished = !!row.completed;
  const usage = record(end.usage);
  const inputTokens = end.inputTokens ?? usage.inputTokens ?? usage.promptTokens;
  const outputTokens = end.outputTokens ?? usage.outputTokens ?? usage.completionTokens;
  const failed =
    row.completed?.type === 'model.failed' ||
    end.isError === true ||
    record(end.result).isError === true;
  const error = end.error ?? record(end.result).error;
  const incomplete = row.observationIncomplete;
  const truncated = row.truncated;
  const active = !finished && running;
  return (
    <article
      className={`execution-operation border border-solid border-line rounded-[8px] overflow-hidden bg-surface ${active ? 'is-active' : ''} ${failed ? 'is-failed' : ''}`}
    >
      <button
        type="button"
        className="execution-operation-heading flex items-center text-left gap-2 w-full p-2.5"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="execution-operation-icon w-6.25 h-6.25 rounded-[6px] flex items-center justify-center bg-[rgb(var(--accent-rgb)_/_0.09)] text-accent shrink-0">
          {failed ? (
            <AlertCircle size={14} />
          ) : finished ? (
            <Check size={14} />
          ) : (
            <ActivityIcon size={14} />
          )}
        </span>
        <span>
          <strong>
            {row.kind === 'model'
              ? t('observe.modelCall')
              : String(start.name ?? end.name ?? t('observe.toolCall'))}
          </strong>
          <small>
            {row.step ? `${t('observe.iteration', { count: row.step })} · ` : ''}
            {String(start.model ?? end.model ?? time(row.at, locale))}
          </small>
        </span>
        <span className="execution-operation-time text-[9px] text-muted whitespace-nowrap">
          {finished
            ? durationLabel(
                typeof end.durationMs === 'number'
                  ? end.durationMs
                  : duration(row.at, row.completed?.at),
              )
            : active
              ? t('observe.live')
              : t('observe.incomplete')}
        </span>
        <ChevronRight className={open ? 'expanded' : ''} size={13} />
      </button>
      {row.kind === 'model' && (row.text || active) ? (
        <div className="execution-response pt-0 pb-3 px-3">
          <span className="execution-response-label text-[9px] text-muted">
            {t(finished && !failed ? 'observe.modelResponse' : 'observe.partialResponse')}
          </span>
          <pre>
            {row.text || t('observe.waitingForText')}
            {active && row.text ? (
              <span className="execution-text-cursor inline-block bg-accent w-1.25 h-3 ml-0.75 [vertical-align:text-bottom] [animation:execution-pulse_1s_infinite]" />
            ) : null}
          </pre>
        </div>
      ) : null}
      {failed ? (
        <p className="execution-operation-error text-danger text-[10px] leading-[1.6] pt-0 pb-2.5 wrap-anywhere px-3 m-0">
          {t('observe.operationFailed')}
          {error ? `: ${typeof error === 'string' ? error : JSON.stringify(error)}` : ''}
        </p>
      ) : null}
      {truncated || incomplete ? (
        <p className="execution-observation-notice text-muted text-[9px] leading-[1.5] pt-0 pb-2.5 px-3 m-0">
          {t(incomplete ? 'observe.observationIncomplete' : 'observe.observationTruncated')}
        </p>
      ) : null}
      {inputTokens !== undefined ||
      outputTokens !== undefined ||
      typeof end.firstTokenMs === 'number' ? (
        <div className="execution-usage flex flex-wrap gap-3 border-t border-solid border-t-line text-[9px] text-muted px-3 py-2">
          {typeof end.firstTokenMs === 'number' ? (
            <span>
              {t('observe.firstText')} {durationLabel(end.firstTokenMs)}
            </span>
          ) : null}
          {inputTokens !== undefined || outputTokens !== undefined ? (
            <span>
              {t('observe.tokens')} {String(inputTokens ?? '—')} → {String(outputTokens ?? '—')}
            </span>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div className="execution-operation-details border-t border-solid border-t-line p-2.5">
          <DataBlock
            label={row.kind === 'model' ? t('observe.promptContext') : t('observe.arguments')}
            value={row.kind === 'model' ? (start.messages ?? start) : (start.arguments ?? start)}
            open
          />
          {finished ? <DataBlock label={t('observe.resultDetails')} value={end} /> : null}
        </div>
      ) : null}
    </article>
  );
}
