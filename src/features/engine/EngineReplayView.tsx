import { ArrowRight, History, RefreshCw, StepBack, StepForward } from 'lucide-react';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import GraphView from '../../components/graph/GraphView';
import { Status, time } from '../../components/ui';
import { engineCall, engineError } from '../../lib/engine/client';
import { appendReplayEvents, replayRun } from '../../lib/engine/history';
import {
  duration,
  durationLabel,
  executionGraphs,
  graphInstances,
  graphStatuses,
  packageGraphs,
} from '../../lib/engine/observation';
import type { EngineEvent, EngineRun, Page } from '../../lib/engine/types';
import { useI18n } from '../../lib/i18n';
import { HistoryPreview } from './HistoryPreview';

export function EngineReplayView({
  run,
  connected,
  onLive,
}: {
  run: EngineRun;
  connected: boolean;
  onLive: () => void;
}) {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [count, setCount] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [groupKey, setGroupKey] = useState('root');
  const [selected, setSelected] = useState('');
  const revision = useRef(0);
  const loading = useRef(false);
  const loadedRun = useRef('');

  async function load(reset: boolean) {
    if (!connected || loading.current) return;

    loading.current = true;
    const generation = revision.current;
    setBusy(true);
    setError('');
    let nextCursor = reset ? null : cursor;
    let nextEvents = reset ? [] : events;
    let inspected = reset ? 0 : scanned;
    let done = false,
      capped = false;

    try {
      // Bound each action's network work. The continuation remains explicit.
      for (let page = 0; page < 20; page++) {
        const result: Page<EngineEvent> = await engineCall({
          op: 'history',
          runId: run.id,
          cursor: nextCursor,
        });
        if (generation !== revision.current) return;
        inspected += result.items.length;
        const retained = appendReplayEvents(nextEvents, result.items);
        nextEvents = retained.events;
        capped = retained.limited;
        done = result.nextCursor === null;
        if (result.nextCursor && result.nextCursor === nextCursor)
          throw new Error(t('history.cursorDidNotAdvance'));
        nextCursor = result.nextCursor;
        if (done || capped) break;
      }

      setEvents(nextEvents);
      setCursor(nextCursor);
      setComplete(done);
      setLimited(capped);
      setScanned(inspected);
      if (reset) setCount(nextEvents.length);
    } catch (cause) {
      if (generation === revision.current) setError(engineError(cause).message);
    } finally {
      if (generation === revision.current) {
        loading.current = false;
        setBusy(false);
      }
    }
  }

  const initialize = useEffectEvent((runId: string, isConnected: boolean) => {
    revision.current++;
    loading.current = false;
    const changedRun = loadedRun.current !== runId;
    loadedRun.current = runId;
    if (changedRun) {
      setEvents([]);
      setCursor(null);
      setComplete(false);
      setLimited(false);
      setCount(0);
      setScanned(0);
      setGroupKey('root');
      setSelected('');
    }
    setBusy(false);
    setError('');
    if (isConnected && (changedRun || events.length === 0)) void load(true);
  });

  useEffect(() => {
    initialize(run.id, connected);
    return () => {
      revision.current++;
      loading.current = false;
    };
  }, [run.id, connected]);

  const historical = useMemo(() => replayRun(run, events, count), [run, events, count]);
  const graphs = useMemo(() => packageGraphs(run), [run]);
  const groups = useMemo(() => executionGraphs(historical, graphs), [historical, graphs]);
  const group = groups.find((item) => item.key === groupKey) ?? groups[0];
  const instances = graphInstances(group);
  const selectedInstance = group?.key === groupKey ? instances[selected] : undefined;
  const current = events[count - 1];

  return (
    <section
      className="history-view min-w-0 flex flex-col gap-3.5"
      aria-label={t('history.replay')}
    >
      <div className="history-toolbar flex items-center gap-3 justify-between">
        <div>
          <strong>
            <History size={16} />
            {t('history.savedState')}
          </strong>
          <p>{t('history.replayExplanation')}</p>
        </div>
        <button type="button" className="button" onClick={onLive}>
          {t('history.returnLive')}
          <ArrowRight size={14} />
        </button>
      </div>
      <div className="history-transport flex items-center gap-3 bg-surface-raised border border-solid border-line rounded-[10px] p-3">
        <button
          type="button"
          className="icon-button"
          aria-label={t('history.previous')}
          disabled={count === 0}
          onClick={() => setCount((value) => Math.max(0, value - 1))}
        >
          <StepBack size={17} />
        </button>
        <input
          type="range"
          min={0}
          max={events.length}
          step={1}
          value={count}
          onChange={(event) => setCount(Number(event.target.value))}
          aria-label={t('history.position')}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={t('history.next')}
          disabled={count === events.length}
          onClick={() => setCount((value) => Math.min(events.length, value + 1))}
        >
          <StepForward size={17} />
        </button>
        <span>{t('history.transitionCount', { current: count, total: events.length })}</span>
        <Status status={historical.status} />
      </div>
      <div className="history-cursor wrap-anywhere">
        <span>
          {current
            ? `${time(current.at, locale)} · ${current.instanceId ? (historical.instances.find((item) => item.id === current.instanceId)?.nodeId ?? current.instanceId) : run.title} · ${current.message}`
            : t('history.accepted')}
        </span>
      </div>
      <div className="history-load flex items-center gap-3 flex-wrap">
        <span className="muted text-muted">
          {t('history.readCount', { count: scanned })} ·{' '}
          {t(complete ? 'history.loaded' : 'history.partial')}
        </span>
        <button
          type="button"
          className="button small text-[11px]"
          disabled={!connected || busy}
          onClick={() => void load(true)}
        >
          <RefreshCw size={13} />
          {t('history.reload')}
        </button>
        {!complete && !limited && (
          <button
            type="button"
            className="button small text-[11px]"
            disabled={!connected || busy}
            onClick={() => void load(false)}
          >
            {t(busy ? 'history.loading' : 'history.loadMore')}
          </button>
        )}
      </div>
      {!connected && (
        <p className="history-notice border border-solid border-line bg-surface-raised rounded-[7px] text-[12px] wrap-anywhere px-3 py-2.5">
          {t('history.connect')}
        </p>
      )}
      {error && (
        <p
          className="history-notice border border-solid border-line bg-surface-raised rounded-[7px] text-[12px] wrap-anywhere px-3 py-2.5"
          role="alert"
        >
          {error}
        </p>
      )}
      {limited && (
        <p className="history-notice border border-solid border-line bg-surface-raised rounded-[7px] text-[12px] wrap-anywhere px-3 py-2.5">
          {t('history.limit')}
        </p>
      )}
      {groups.length > 1 && (
        <label className="history-scope flex items-center gap-3">
          {t('history.scope')}
          <select
            aria-label={t('history.scope')}
            value={group?.key}
            onChange={(event) => {
              setGroupKey(event.target.value);
              setSelected('');
            }}
          >
            {groups.map((item) => (
              <option value={item.key} key={item.key}>
                {item.key === 'root'
                  ? t('execution.rootGraph')
                  : `${historical.instances.find((node) => node.id === item.parentId)?.nodeId ?? item.scope} ${item.iterationIndex === undefined ? '' : `[${item.iterationIndex + 1}]`} · ${item.path || item.scope}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="history-workspace grid grid-cols-[minmax(0,_1fr)_330px] min-h-112.5 border border-solid border-line rounded-[12px] overflow-hidden">
        <div className="history-graph flex min-h-112.5 h-[min(60vh,_650px)] min-w-0">
          {group ? (
            <GraphView
              key={group.key}
              graph={group.graph}
              selected={group?.key === groupKey ? selected : undefined}
              onSelect={(id) => {
                if (group) setGroupKey(group.key);
                setSelected(id);
              }}
              statuses={graphStatuses(group)}
              importedGraphs={graphs}
              observations={Object.fromEntries(
                Object.entries(instances).map(([id, instance]) => [id, instance.reason ?? '']),
              )}
            />
          ) : (
            <p>{t('history.noGraph')}</p>
          )}
        </div>
        <aside
          className="history-inspector border-l border-solid border-l-line min-w-0 max-h-162.5 overflow-auto bg-surface p-4.5"
          aria-label={t('history.savedDetails')}
        >
          {selectedInstance ? (
            <>
              <div className="history-inspector-title flex items-center gap-3 justify-between">
                <strong>{selectedInstance.nodeId}</strong>
                <Status status={selectedInstance.status} />
              </div>
              {selectedInstance.reason && <p>{selectedInstance.reason}</p>}
              <p className="muted text-muted">
                {selectedInstance.scope} ·{' '}
                {durationLabel(
                  duration(
                    selectedInstance.startedAt,
                    selectedInstance.finishedAt ?? historical.updatedAt,
                  ),
                )}
              </p>
              {selectedInstance.dataTruncated && (
                <p className="history-notice border border-solid border-line bg-surface-raised rounded-[7px] text-[12px] wrap-anywhere px-3 py-2.5">
                  {t('history.contextLimited')}
                </p>
              )}
              <h4>{t('history.inputs')}</h4>
              <HistoryPreview value={selectedInstance.inputs} />
              <h4>{t('history.outputs')}</h4>
              <HistoryPreview value={selectedInstance.outputs} />
              {selectedInstance.error && (
                <p className="history-notice border border-solid border-line bg-surface-raised rounded-[7px] text-[12px] wrap-anywhere px-3 py-2.5">
                  {selectedInstance.error.message}
                </p>
              )}
            </>
          ) : (
            <>
              <h3>{selected ? selected : t('history.selectNode')}</h3>
              <p className="muted text-muted">
                {t(selected ? 'history.notStarted' : 'history.inspectorExplanation')}
              </p>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
