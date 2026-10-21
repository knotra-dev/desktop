import {
  Activity as ActivityIcon,
  AlertCircle,
  Clock3,
  Focus,
  GitBranch,
  Layers3,
  Radio,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import GraphView from '../../components/graph/GraphView';
import { Empty, time } from '../../components/ui';
import {
  duration,
  durationLabel,
  type ExecutionGraph,
  executionGraphs,
  graphInstances,
  graphStatuses,
  packageGraphs,
} from '../../lib/engine/observation';
import {
  type EngineEvent,
  type EngineInstance,
  type EngineRun,
  terminal,
} from '../../lib/engine/types';
import { dependencies } from '../../lib/graph';
import { useI18n } from '../../lib/i18n';
import { EdgeInspector, type EdgeSelection } from './execution/EdgeInspector';
import { ExecutionWaterfall } from './execution/ExecutionWaterfall';
import { InstanceInspector } from './execution/InstanceInspector';

export default function EngineExecutionView({
  run,
  events,
  connection,
  connected,
  onReview,
  onResolve,
}: {
  run: EngineRun;
  events: EngineEvent[];
  connection: string;
  connected: boolean;
  onReview: () => void;
  onResolve: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const graphs = useMemo(() => packageGraphs(run), [run]);
  const groups = useMemo(() => executionGraphs(run, graphs), [run, graphs]);
  const [groupKey, setGroupKey] = useState('root');
  const [selected, setSelected] = useState('');
  const [edge, setEdge] = useState<EdgeSelection>();
  const [follow, setFollow] = useState(false);
  const [showWaterfall, setShowWaterfall] = useState(false);
  const [now, setNow] = useState(Date.now());
  const group = groups.find((item) => item.key === groupKey) ?? groups[0];
  const instances = useMemo(() => graphInstances(group), [group]);
  const statuses = useMemo(() => (group ? graphStatuses(group) : {}), [group]);
  const selectedInstance = instances[selected];
  const node = group?.graph.nodes[selected];

  useEffect(() => {
    if (terminal(run.status)) return;

    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.status]);

  useEffect(() => {
    if (!follow) return;

    const active = [...run.instances]
      .reverse()
      .find((item) => ['running', 'waiting_human', 'waiting_resolution'].includes(item.status));
    const location =
      active && groups.find((item) => item.instances.some((instance) => instance.id === active.id));
    if (active && location) {
      setGroupKey(location.key);
      setSelected(active.nodeId);
      setEdge(undefined);
    }
  }, [follow, run.instances, groups]);

  const counts = run.instances.reduce<Record<string, number>>((counts, instance) => {
    counts[instance.status] = (counts[instance.status] ?? 0) + 1;
    return counts;
  }, {});

  function pick(id: string) {
    setSelected(id);
    setEdge(undefined);
    setFollow(false);
  }

  function pickInstance(instance: EngineInstance) {
    const location = groups.find((item) =>
      item.instances.some((entry) => entry.id === instance.id),
    );
    if (location) {
      setGroupKey(location.key);
      pick(instance.nodeId);
    }
  }

  function groupLabel(entry: ExecutionGraph) {
    if (entry.key === 'root') return t('execution.rootGraph');
    const labels: string[] = [];
    const visited = new Set<string>();
    let parentId = entry.parentId;
    let iteration = entry.iterationIndex;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = run.instances.find((item) => item.id === parentId);
      if (!parent) break;
      labels.unshift(
        `${parent.nodeId}${iteration === undefined ? '' : ` · ${t('observe.iteration', { count: iteration + 1 })}`}`,
      );
      parentId = parent.parentInstanceId;
      iteration = parent.iterationIndex;
    }
    return labels.length ? labels.join(' / ') : entry.scope;
  }

  const observations = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(instances).map(([id, instance]) => {
          const children = run.instances.filter((item) => item.parentInstanceId === instance.id);
          const blockers =
            instance.status === 'pending' && group?.graph.nodes[id]
              ? dependencies(group.graph.nodes[id]).filter(
                  (dependency) =>
                    !['succeeded', 'skipped'].includes(instances[dependency]?.status ?? 'pending'),
                )
              : [];
          const summary = children.length
            ? t('observe.childrenProgress', {
                done: children.filter((item) => terminal(item.status)).length,
                total: children.length,
              })
            : undefined;
          return [
            id,
            summary ??
              (blockers.length
                ? `${t('observe.waitsFor')}: ${blockers.join(', ')}`
                : instance.status === 'pending'
                  ? undefined
                  : instance.reason) ??
              durationLabel(
                duration(
                  instance.startedAt,
                  instance.finishedAt ??
                    (terminal(instance.status) ? (instance.updatedAt ?? run.updatedAt) : now),
                ),
              ),
          ];
        }),
      ),
    [instances, group, run.instances, run.updatedAt, now, t],
  );
  const latest = events.at(-1)?.at;
  const unresolved = run.availableActions.includes('resolve')
    ? run.instances.filter((instance) => instance.status === 'waiting_resolution')
    : [];

  return (
    <div className="execution-observer flex flex-col min-w-0 w-full border border-solid border-line rounded-[12px] overflow-hidden bg-surface">
      <div className="execution-summary flex items-center justify-between flex-wrap gap-2.5 shrink-0 border-b border-solid border-b-line bg-surface-raised px-3.75 py-3">
        <div className="execution-counts gap-4 flex-wrap text-[11px] text-secondary">
          <span className="execution-summary-label text-foreground font-semibold">
            <ActivityIcon size={15} />
            {t('observe.execution')}
          </span>
          <span>
            <i className="execution-dot state-succeeded h-1.5 w-1.5 rounded-full bg-current" />
            {t('observe.doneCount', { count: counts.succeeded ?? 0 })}
          </span>
          <span>
            <i className="execution-dot state-running h-1.5 w-1.5 rounded-full bg-current" />
            {t('observe.runningCount', { count: counts.running ?? 0 })}
          </span>
          <span>
            <i className="execution-dot state-waiting_human h-1.5 w-1.5 rounded-full bg-current" />
            {t('observe.waitingCount', {
              count:
                (counts.waiting_human ?? 0) +
                (counts.waiting_resolution ?? 0) +
                (counts.retry_wait ?? 0),
            })}
          </span>
          {counts.failed ? (
            <span className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap">
              {t('observe.failedCount', { count: counts.failed })}
            </span>
          ) : null}
          {counts.skipped ? (
            <span>{t('observe.skippedCount', { count: counts.skipped })}</span>
          ) : null}
        </div>
        <span
          className={`execution-connection text-[10px] text-muted max-w-80 ${connection === t('execution.connected') ? 'is-connected' : ''}`}
          title={latest ? `${t('observe.lastEvent')}: ${time(latest, locale)}` : connection}
        >
          <Radio size={13} />
          {connection}
        </span>
      </div>
      {unresolved.length ? (
        <section
          className="execution-attention shrink-0 max-h-37.5 overflow-auto border-b border-solid border-b-line bg-[color-mix(in_srgb,_var(--amber)_6%,_var(--surface))]"
          aria-label={t('execution.waitingResolution')}
        >
          {unresolved.map((instance) => (
            <div key={instance.id}>
              <AlertCircle size={16} />
              <span>
                <strong>{instance.nodeId}</strong>
                <small>{t('execution.waitingResolution')}</small>
              </span>
              <button
                type="button"
                className="button"
                disabled={!connected}
                onClick={() => onResolve(instance.id)}
              >
                {t('execution.resolveUnknownOutcome')}
              </button>
            </div>
          ))}
        </section>
      ) : null}
      <div className="execution-toolbar flex items-center justify-between flex-wrap gap-2.5 shrink-0 border-b border-solid border-b-line px-3 py-2">
        <label className="execution-scope-picker text-secondary min-w-0">
          <Layers3 size={15} />
          <select
            aria-label={t('observe.graphScope')}
            value={group?.key ?? ''}
            onChange={(event) => {
              setGroupKey(event.target.value);
              setSelected('');
              setEdge(undefined);
              setFollow(false);
            }}
          >
            {groups.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {groupLabel(entry)}
              </option>
            ))}
          </select>
        </label>
        <div className="execution-toolbar-actions">
          <button
            type="button"
            className={`button small text-[11px] ${follow ? 'active' : ''}`}
            aria-pressed={follow}
            onClick={() => setFollow(!follow)}
          >
            <Focus size={14} />
            {t('observe.follow')}
          </button>
          <button
            type="button"
            className={`button small text-[11px] ${showWaterfall ? 'active' : ''}`}
            aria-pressed={showWaterfall}
            onClick={() => setShowWaterfall(!showWaterfall)}
          >
            <Clock3 size={14} />
            {t('observe.timing')}
          </button>
        </div>
      </div>
      <div
        className={`execution-workspace flex flex-1 min-h-45 min-w-0 ${selected || edge ? 'has-inspector' : ''}`}
      >
        <div className="execution-canvas relative flex flex-1 min-w-37.5">
          {group ? (
            <GraphView
              key={group.key}
              graph={group.graph}
              importedGraphs={graphs}
              selected={selected}
              statuses={statuses}
              observations={observations}
              onSelect={pick}
              onSelectEdge={(value) => {
                setEdge(value);
                setSelected('');
                setFollow(false);
              }}
              onOpenBody={(id) => {
                const child = groups.find((entry) => entry.parentId === instances[id]?.id);
                if (child) {
                  setGroupKey(child.key);
                  setSelected('');
                  setFollow(false);
                }
              }}
            />
          ) : (
            <Empty icon={<GitBranch />} title={t('observe.noGraph')}>
              {t('observe.noGraphDetail')}
            </Empty>
          )}
          {!selected && !edge && group ? (
            <div className="execution-canvas-hint absolute bottom-4 left-[50%] [transform:translateX(-50%)] border border-solid border-line bg-surface-raised text-secondary rounded-[8px] flex items-center gap-1.75 text-[11px] w-max max-w-[80%] pointer-events-none shadow-[0_3px_16px_#0001] px-3 py-2">
              <Focus size={14} />
              {t('observe.selectHint')}
            </div>
          ) : null}
        </div>
        {node && group ? (
          <InstanceInspector
            key={selectedInstance?.id ?? `${group.key}:${selected}`}
            run={run}
            instance={selectedInstance}
            node={node}
            nodeId={selected}
            group={group}
            groups={groups}
            events={events}
            connected={connected}
            follow={follow}
            now={now}
            onClose={() => {
              setSelected('');
              setFollow(false);
            }}
            onReview={onReview}
            onSelectInstance={pickInstance}
            onSelectNode={pick}
          />
        ) : null}
        {edge && group ? (
          <EdgeInspector
            edge={edge}
            instances={instances}
            onClose={() => setEdge(undefined)}
            onSelectNode={pick}
          />
        ) : null}
      </div>
      {showWaterfall ? (
        <ExecutionWaterfall
          run={run}
          now={now}
          selectedInstanceId={selectedInstance?.id}
          onSelectInstance={pickInstance}
        />
      ) : null}
    </div>
  );
}
