import { Activity as ActivityIcon, ArrowLeft, ChevronRight, Clock3, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NodeIcon, Status, time } from '../../../components/ui';
import {
  type Activity,
  activities,
  duration,
  durationLabel,
  type ExecutionGraph,
  graphInstances,
  instanceArtifacts,
} from '../../../lib/engine/observation';
import {
  type EngineEvent,
  type EngineInstance,
  type EngineRun,
  terminal,
} from '../../../lib/engine/types';
import { dependencies } from '../../../lib/graph';
import { useI18n } from '../../../lib/i18n';
import { type NodeDefinition, record } from '../../../lib/types';
import { Diagnostics } from '../EngineDiagnostics';
import { ActivityCard } from './ActivityCard';
import { ArtifactCard } from './ArtifactCard';
import { DataBlock } from './DataBlock';
import { eventLabel } from './eventLabel';
import { useInstanceHistory } from './useInstanceHistory';

export function InstanceInspector({
  run,
  instance,
  node,
  nodeId,
  group,
  groups,
  events,
  connected,
  follow,
  now,
  onClose,
  onReview,
  onSelectInstance,
  onSelectNode,
}: {
  run: EngineRun;
  instance?: EngineInstance;
  node: NodeDefinition;
  nodeId: string;
  group: ExecutionGraph;
  groups: ExecutionGraph[];
  events: EngineEvent[];
  connected: boolean;
  follow: boolean;
  now: number;
  onClose: () => void;
  onReview: () => void;
  onSelectInstance: (instance: EngineInstance) => void;
  onSelectNode: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState('activity');
  const [attempt, setAttempt] = useState('all');
  const [visibleRows, setVisibleRows] = useState(150);
  const [showStateHistory, setShowStateHistory] = useState(false);
  const inspectorBody = useRef<HTMLDivElement>(null);
  const activityList = useRef<HTMLDivElement>(null);
  const id = instance?.id;
  const { ownEvents, cursor, loading, historyError, historyLimited, loadMore } = useInstanceHistory(
    run.id,
    id,
    events,
    connected,
  );
  const attempts = [
    ...new Set(ownEvents.flatMap((event) => (event.attemptId ? [event.attemptId] : []))),
  ];
  const rows = useMemo(
    () => activities(ownEvents.filter((event) => attempt === 'all' || event.attemptId === attempt)),
    [ownEvents, attempt],
  );
  const [activityRows, stateRows] = useMemo(() => {
    if (!['llm', 'agent'].includes(node.type) || !rows.some((row) => row.kind !== 'event'))
      return [rows, []];
    const routine = (row: Activity) =>
      row.kind === 'event' &&
      row.events[0].type === 'node' &&
      ['pending', 'ready', 'running', 'succeeded'].includes(
        String(record(row.events[0].data).status ?? row.events[0].message),
      );
    return [rows.filter((row) => !routine(row)), rows.filter(routine)];
  }, [rows, node.type]);
  const children = run.instances.filter((item) => item.parentInstanceId === id && id);
  const blockers = dependencies(node).filter(
    (dependency) =>
      !['succeeded', 'skipped'].includes(graphInstances(group)[dependency]?.status ?? 'pending'),
  );
  const status = instance?.status ?? 'pending';
  const parent = run.instances.find((item) => item.id === instance?.parentInstanceId);
  const artifacts = instanceArtifacts(run, instance);
  const latest = ownEvents.at(-1);
  useEffect(() => {
    if (!follow || tab !== 'activity' || (!latest?.id && !activityRows.length)) return;
    const frame = requestAnimationFrame(() => {
      const body = inspectorBody.current;
      const list = activityList.current;
      if (!body || !list) return;
      const responses = list.querySelectorAll<HTMLElement>('.execution-response pre');
      const response = responses[responses.length - 1];
      if (response) response.scrollTop = response.scrollHeight;
      // Scroll only this inspector, leaving the graph and the application viewport fixed.
      body.scrollTop +=
        list.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 12;
    });
    return () => cancelAnimationFrame(frame);
  }, [follow, tab, latest?.id, activityRows.length]);
  const activeOperation = rows
    .filter(
      (row) => row.kind !== 'event' && !row.completed && row.attemptId === instance?.attemptId,
    )
    .at(-1);
  const config = record(node[node.type]);
  return (
    <aside
      className="execution-inspector w-[clamp(330px,_36%,_520px)] min-w-0 flex flex-col border-l border-solid border-l-line bg-surface-raised"
      aria-label={t('observe.nodeDetails')}
    >
      <header className="execution-inspector-heading flex justify-between items-start pt-4.25 pb-2.25 gap-2 px-4.5">
        <div>
          <small>
            <NodeIcon kind={node.type} size={13} />
            {node.type}
          </small>
          <h2>{nodeId}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('observe.close')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="execution-node-meta justify-between pt-0 pb-3.5 text-[10px] text-muted px-4.5">
        <Status status={status} />
        <span>
          <Clock3 size={12} />
          {durationLabel(
            duration(
              instance?.startedAt,
              instance?.finishedAt ??
                (terminal(status) ? (instance?.updatedAt ?? run.updatedAt) : now),
            ),
          )}
        </span>
      </div>
      {parent ? (
        <button
          type="button"
          className="execution-parent-link text-[10px] text-secondary text-left flex items-center gap-1.5 pt-0 pb-3 px-4.5"
          onClick={() => onSelectInstance(parent)}
        >
          <ArrowLeft size={12} />
          {parent.nodeId}
          {instance?.iterationIndex === undefined
            ? ''
            : ` · ${t('observe.iteration', { count: instance.iterationIndex + 1 })}`}
        </button>
      ) : null}
      <div className="execution-detail-tabs flex border-b border-solid border-b-line gap-4.25 px-3.75 py-0">
        {['activity', 'data', 'definition'].map((value) => (
          <button
            type="button"
            key={value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {t(`observe.${value}`)}
          </button>
        ))}
      </div>
      <div
        className="execution-inspector-body overflow-auto min-h-0 flex-1 p-3.75"
        ref={inspectorBody}
      >
        {instance?.error ? <Diagnostics diagnostics={[instance.error]} /> : null}
        {instance?.reason && status !== 'pending' ? (
          <p className="execution-wait-reason text-[11px] leading-[1.6] border border-solid border-line bg-surface rounded-[7px] wrap-anywhere mt-0 mb-3.5 px-3 py-2.5 mx-0">
            {instance.reason}
          </p>
        ) : null}
        {status === 'pending' && blockers.length ? (
          <div className="execution-wait-reason text-[11px] leading-[1.6] border border-solid border-line bg-surface rounded-[7px] wrap-anywhere mt-0 mb-3.5 px-3 py-2.5 mx-0">
            {t('observe.waitsFor')}
            <div>
              {blockers.map((dependency) => (
                <button
                  type="button"
                  className="text-button"
                  key={dependency}
                  onClick={() => onSelectNode(dependency)}
                >
                  {dependency}
                  <ChevronRight size={12} />
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {status === 'waiting_human' ? (
          <button type="button" className="button primary" onClick={onReview}>
            {t('execution.reviewRequest')}
          </button>
        ) : null}
        {tab === 'activity' ? (
          <>
            {['llm', 'agent'].includes(node.type) ? (
              <div className="execution-model-summary flex justify-between gap-2.5 text-muted text-[10px] mb-3">
                <span>{String(config.model ?? '')}</span>
                {node.type === 'agent' ? (
                  <span>
                    {t('observe.agentStep', {
                      step: Math.max(
                        0,
                        ...ownEvents
                          .filter(
                            (event) =>
                              event.attemptId ===
                              (attempt === 'all' ? instance?.attemptId : attempt),
                          )
                          .map((event) => Number(record(event.data).step) || 0),
                      ),
                      max: String(config.maxSteps ?? '—'),
                    })}
                  </span>
                ) : null}
              </div>
            ) : null}
            {status === 'running' ? (
              <div className="execution-current flex gap-2.5 items-center border border-solid border-[rgb(var(--accent-rgb)_/_0.3)] rounded-[8px] bg-[rgb(var(--accent-rgb)_/_0.04)] mb-3.75 p-2.75">
                <span className="execution-live-dot w-1.75 h-1.75 shrink-0 bg-accent rounded-full [animation:execution-pulse_2s_infinite]" />
                <div>
                  <small>{t('observe.currentOperation')}</small>
                  <strong>
                    {activeOperation
                      ? t(
                          activeOperation.kind === 'model'
                            ? 'observe.generating'
                            : 'observe.toolRunning',
                        )
                      : latest
                        ? eventLabel(latest, t)
                        : t('observe.executing')}
                  </strong>
                </div>
              </div>
            ) : null}
            {attempts.length > 1 ? (
              <label className="execution-attempt-picker flex flex-col gap-1.5 text-[10px] text-muted mb-3">
                {t('observe.attempt')}
                <select value={attempt} onChange={(event) => setAttempt(event.target.value)}>
                  <option value="all">{t('observe.allAttempts')}</option>
                  {attempts.map((value, index) => (
                    <option key={value} value={value}>
                      {index + 1} · {value}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {loading ? (
              <p className="small muted text-[11px] text-muted" role="status">
                {t('observe.loadingHistory')}
              </p>
            ) : null}
            {historyError ? (
              <p className="small muted text-[11px] text-muted">
                {t('observe.historyUnavailable')} {historyError}
              </p>
            ) : null}
            {cursor || historyLimited ? (
              <p className="execution-wait-reason text-[11px] leading-[1.6] border border-solid border-line bg-surface rounded-[7px] wrap-anywhere mt-0 mb-3.5 px-3 py-2.5 mx-0">
                {t(historyLimited ? 'observe.historyLimited' : 'observe.historyPartial')}
              </p>
            ) : null}
            {cursor ? (
              <button
                type="button"
                className="button small text-[11px]"
                disabled={loading || !connected}
                onClick={() => void loadMore()}
              >
                {t('observe.loadMore')}
              </button>
            ) : null}
            <div className="execution-activity-list flex flex-col gap-2.5" ref={activityList}>
              {activityRows.slice(-visibleRows).map((row) => (
                <ActivityCard
                  key={row.id}
                  row={row}
                  running={
                    status === 'running' &&
                    (!row.attemptId || row.attemptId === instance?.attemptId)
                  }
                />
              ))}
            </div>
            {stateRows.length ? (
              <details
                className="execution-state-history mt-3.5 border-t border-solid border-t-line pt-2.5 text-muted"
                onToggle={(event) => setShowStateHistory(event.currentTarget.open)}
              >
                <summary>{t('observe.stateHistory', { count: stateRows.length })}</summary>
                {showStateHistory
                  ? stateRows
                      .slice(-visibleRows)
                      .map((row) => <ActivityCard key={row.id} row={row} running={false} />)
                  : null}
              </details>
            ) : null}
            {activityRows.length > visibleRows || stateRows.length > visibleRows ? (
              <button
                type="button"
                className="button small text-[11px]"
                onClick={() => setVisibleRows((count) => count + 150)}
              >
                {t('observe.showEarlier')}
              </button>
            ) : null}
            {!rows.length && !loading ? (
              <div className="execution-empty-detail text-center text-muted text-[11px] leading-[1.6] px-2.5 py-6.5">
                <ActivityIcon size={24} />
                <p>{t(instance ? 'observe.noActivity' : 'observe.notStarted')}</p>
              </div>
            ) : null}
            {children.length ? (
              <div className="execution-children">
                <h3>{t('observe.childInstances')}</h3>
                {children.map((child) => (
                  <button
                    type="button"
                    key={child.id}
                    onClick={() => onSelectInstance(child)}
                    disabled={
                      !groups.some((entry) => entry.instances.some((item) => item.id === child.id))
                    }
                  >
                    <span>
                      {child.nodeId}
                      <small>
                        {child.iterationIndex === undefined
                          ? child.scope
                          : t('observe.iteration', { count: child.iterationIndex + 1 })}
                      </small>
                    </span>
                    <Status status={child.status} />
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : tab === 'data' ? (
          <>
            {instance?.dataTruncated ? (
              <p className="execution-wait-reason text-[11px] leading-[1.6] border border-solid border-line bg-surface rounded-[7px] wrap-anywhere mt-0 mb-3.5 px-3 py-2.5 mx-0">
                {t('observe.dataTruncated')}
              </p>
            ) : null}
            <DataBlock label={t('execution.inputs')} value={instance?.inputs} open />
            <DataBlock label={t('execution.outputs')} value={instance?.outputs} open />
            {node.type === 'switch' ? (
              <DataBlock label={t('observe.routingConditions')} value={node.switch} open />
            ) : null}
            {artifacts.length ? (
              <section className="execution-artifacts">
                <h3>{t('observe.artifacts')}</h3>
                {artifacts.map((artifact) => (
                  <ArtifactCard key={artifact.id} artifact={artifact} connected={connected} />
                ))}
              </section>
            ) : null}
            <DataBlock
              label={t('observe.runtimeIdentity')}
              value={
                instance
                  ? {
                      id: instance.id,
                      scope: instance.scope,
                      graphPath: instance.graphPath,
                      attemptId: instance.attemptId,
                      startedAt: instance.startedAt,
                      finishedAt: instance.finishedAt,
                    }
                  : undefined
              }
            />
          </>
        ) : (
          <>
            <p className="small muted text-[11px] text-muted">{t('observe.immutableDefinition')}</p>
            <DataBlock label={nodeId} value={node} open />
          </>
        )}
        {latest ? (
          <p className="execution-last-event text-[9px] text-muted mt-5">
            {t('observe.lastEvent')} · {time(latest.at, locale)}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
