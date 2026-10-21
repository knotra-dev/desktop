import { Activity, AlertCircle, Check, Clock3, Radio, Workflow } from 'lucide-react';
import { useMemo } from 'react';
import { nodeMeta } from '../../../components/ui';
import { duration, durationLabel } from '../../../lib/engine/observation';
import { type TimelineRow, timelineNodeLabel, timelineRows } from '../../../lib/engine/timeline';
import { type EngineEvent, type EngineRun, terminal } from '../../../lib/engine/types';
import { localeTag, type MessageKey, useI18n } from '../../../lib/i18n';
import { type NodeKind, record } from '../../../lib/types';
import { DataBlock } from './DataBlock';
import { eventLabel } from './eventLabel';

const stepActions: Record<string, MessageKey> = {
  pending: 'timeline.pending',
  ready: 'timeline.ready',
  running: 'timeline.started',
  retry_wait: 'timeline.retry',
  waiting_human: 'timeline.waitingHuman',
  waiting_resolution: 'timeline.waitingResolution',
  succeeded: 'timeline.completed',
  skipped: 'timeline.skipped',
  failed: 'timeline.failed',
  cancelled: 'timeline.cancelled',
};

const runActions: Record<string, MessageKey> = {
  running: 'timeline.runStarted',
  succeeded: 'timeline.runCompleted',
  failed: 'timeline.runFailed',
  cancelled: 'timeline.runCancelled',
};

function TimelineItem({ item, run }: { item: TimelineRow; run: EngineRun }) {
  const { t, locale } = useI18n();
  const { activity: row, instance, node } = item;
  const event = row.completed ?? row.started ?? row.events[0];
  const data = record(event?.data);
  const end = record(row.completed?.data);
  const state = String(data.status ?? event?.message ?? '');
  const stateEvent =
    event && ['node', 'run'].includes(event.type) && Object.hasOwn(stepActions, state);
  const failed = stateEvent
    ? state === 'failed'
    : !!row.completed &&
      (row.completed.type.endsWith('.failed') ||
        end.isError === true ||
        record(end.result).isError === true);
  const waiting =
    stateEvent && ['waiting_human', 'waiting_resolution', 'retry_wait'].includes(state);
  const completed = stateEvent ? state === 'succeeded' : !!row.completed && !failed;
  const active =
    !row.completed &&
    !terminal(run.status) &&
    (!instance || !terminal(instance.status)) &&
    (!row.attemptId || !instance?.attemptId || row.attemptId === instance.attemptId);
  let action: string;
  if (row.kind === 'event') {
    if (stateEvent)
      action = t(
        event.type === 'run' && Object.hasOwn(runActions, state)
          ? runActions[state]
          : stepActions[state],
      );
    else if (
      event &&
      ((event.message && event.message !== event.type) ||
        ['agent.iteration', 'output.validating', 'output.completed'].includes(event.type))
    )
      action = eventLabel(event, t);
    else action = t('timeline.recorded');
  } else if (row.kind === 'model') {
    action = t(
      failed
        ? 'timeline.modelFailed'
        : row.completed
          ? 'timeline.modelCompleted'
          : active
            ? 'observe.generating'
            : 'observe.modelCall',
    );
  } else {
    action = t(
      failed
        ? 'timeline.toolFailed'
        : row.completed
          ? 'timeline.toolCompleted'
          : active
            ? 'observe.toolRunning'
            : 'observe.toolCall',
    );
  }
  const customMessage =
    stateEvent && event.message !== state && event.message !== event.type
      ? event.message
      : undefined;
  const reason =
    customMessage ??
    (typeof data.reason === 'string' ? data.reason : undefined) ??
    (typeof data.error === 'string'
      ? data.error
      : typeof record(data.error).message === 'string'
        ? String(record(data.error).message)
        : undefined);
  const type = node?.type ?? instance?.nodeType;
  const model = record(row.started?.data).model ?? end.model;
  const tool = record(row.started?.data).name ?? end.name;
  const elapsed =
    typeof end.durationMs === 'number' ? end.durationMs : duration(row.at, row.completed?.at);
  const clock = new Intl.DateTimeFormat(localeTag(locale), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const context = item.context
    .map(
      (parent) =>
        `${timelineNodeLabel(parent.nodeId)}${parent.iterationIndex === undefined ? '' : ` · ${t('observe.iteration', { count: parent.iterationIndex + 1 })}`}`,
    )
    .join(' / ');
  const Icon = failed
    ? AlertCircle
    : completed
      ? Check
      : waiting
        ? Clock3
        : row.kind === 'event' && event?.type === 'run'
          ? Workflow
          : Activity;
  return (
    <li className="timeline-event relative grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] gap-3 border-b border-solid border-line py-3 last:border-0 before:absolute before:bottom-0 before:left-3.5 before:top-11 before:w-px before:bg-line last:before:hidden">
      <span
        className={`timeline-marker relative z-1 flex size-7 items-center justify-center rounded-full bg-surface-raised ${failed ? 'text-danger' : waiting ? 'text-amber' : completed ? 'text-accent' : 'text-secondary'}`}
      >
        <Icon size={15} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline justify-between gap-x-4 gap-y-1 max-sm:flex-wrap">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="m-0 min-w-0 text-[13px] font-semibold leading-6 text-foreground wrap-anywhere">
              {instance
                ? timelineNodeLabel(instance.nodeId)
                : t(event?.type === 'node' || row.instanceId ? 'timeline.step' : 'editor.pipeline')}
            </h3>
            <p className={`m-0 text-[12px] leading-6 ${failed ? 'text-danger' : 'text-secondary'}`}>
              {action}
            </p>
          </div>
          <span className="shrink-0 text-[11px] leading-6 text-muted tabular-nums">
            <time dateTime={row.at} title={new Date(row.at).toLocaleString(localeTag(locale))}>
              {clock.format(new Date(row.at))}
            </time>
            {row.completed && row.completed.at !== row.at ? (
              <>
                {' – '}
                <time
                  dateTime={row.completed.at}
                  title={new Date(row.completed.at).toLocaleString(localeTag(locale))}
                >
                  {clock.format(new Date(row.completed.at))}
                </time>
              </>
            ) : null}
          </span>
        </div>
        {reason && reason !== action ? (
          <p className="mt-1 mb-0 max-w-prose text-[12px] leading-5 text-secondary whitespace-pre-wrap wrap-anywhere">
            {reason}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-5 text-muted wrap-anywhere">
          {type && Object.hasOwn(nodeMeta, type) ? (
            <span>{t(nodeMeta[type as NodeKind].label)}</span>
          ) : null}
          {context ? (
            <span>{context}</span>
          ) : instance?.iterationIndex !== undefined ? (
            <span>{t('observe.iteration', { count: instance.iterationIndex + 1 })}</span>
          ) : null}
          {item.attempt && item.attempt > 1 ? (
            <span>{t('timeline.attempt', { count: item.attempt })}</span>
          ) : null}
          {row.kind === 'model' && typeof model === 'string' ? <span>{model}</span> : null}
          {row.kind === 'tool' && typeof tool === 'string' ? <span>{tool}</span> : null}
          {elapsed !== undefined ? <span>{durationLabel(elapsed)}</span> : null}
          {row.kind !== 'event' && !row.completed ? (
            <span>{t(active ? 'observe.live' : 'timeline.incomplete')}</span>
          ) : null}
        </div>
        <div className="[&>.execution-data-block]:mb-0">
          <DataBlock
            label={t('timeline.technicalDetails')}
            value={
              row.kind === 'event'
                ? event
                : {
                    instanceId: row.instanceId,
                    attemptId: row.attemptId,
                    events: row.events,
                    response: row.text || undefined,
                    truncated: row.truncated || undefined,
                    observationIncomplete: row.observationIncomplete || undefined,
                  }
            }
          />
        </div>
      </div>
    </li>
  );
}

export function EngineTimeline({
  run,
  events,
  connection,
}: {
  run: EngineRun;
  events: EngineEvent[];
  connection: string;
}) {
  const { t } = useI18n();
  const rows = useMemo(() => timelineRows(run, events), [run, events]);
  return (
    <section
      className="run-timeline mx-auto w-full max-w-4xl min-w-0 px-1 py-2"
      aria-label={t('timeline.title')}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-solid border-line pb-3">
        <h2 className="m-0 text-[14px] font-semibold text-foreground">{t('timeline.title')}</h2>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
          <Radio size={13} aria-hidden="true" />
          {connection}
        </span>
      </div>
      {rows.length ? (
        <ol className="timeline m-0 list-none p-0">
          {rows.map((item) => (
            <TimelineItem key={item.activity.id} item={item} run={run} />
          ))}
        </ol>
      ) : (
        <p className="py-8 text-[13px] leading-6 text-secondary" role="status">
          {t('timeline.empty')}
        </p>
      )}
      <p className="mt-3 text-[11px] leading-5 text-muted">{t('timeline.recent')}</p>
    </section>
  );
}
