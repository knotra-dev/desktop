import { ArrowLeft, Play, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import SourceEditor from '../../components/editor/SourceEditor';
import { Modal, Status, time } from '../../components/ui';
import {
  engineCall,
  engineError,
  eventWindow,
  storedEvents,
  watchRun,
} from '../../lib/engine/client';
import type { EngineEvent, EngineInstance, EngineRun, Page } from '../../lib/engine/types';
import type { EngineController } from '../../lib/engine/useEngine';
import {
  executionActionLabels,
  executionConnectionLabels,
  executionTabLabels,
} from '../../lib/executionLabels';
import { useI18n } from '../../lib/i18n';
import { EngineCompareView } from './EngineCompareView';
import { Diagnostics } from './EngineDiagnostics';
import EngineExecutionView from './EngineExecutionView';
import { EngineReplayView } from './EngineReplayView';
import { EngineTimeline } from './execution/EngineTimeline';

export function EngineRunDetail({
  run: snapshot,
  engine,
  onBack,
  onReview,
}: {
  run: EngineRun;
  engine: EngineController;
  onBack: () => void;
  onReview: () => void;
}) {
  const { t, locale, message } = useI18n();
  const [expanded, setExpanded] = useState<{
    id: string;
    updatedAt: string;
    instances: EngineInstance[];
    cursor: string | null;
  }>();
  const extra =
    expanded?.id === snapshot.id && expanded.updatedAt === snapshot.updatedAt
      ? expanded
      : undefined;
  const run = extra
    ? {
        ...snapshot,
        instances: [...snapshot.instances, ...extra.instances],
        instancesNextCursor: extra.cursor ?? undefined,
      }
    : snapshot;
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [instanceError, setInstanceError] = useState('');
  const [tab, setTab] = useState('graph');
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [stream, setStream] = useState('Connecting…');
  const [resolution, setResolution] = useState('');
  const [evidence, setEvidence] = useState('');
  const [outcome, setOutcome] = useState<'succeeded' | 'not_started' | 'failed'>('failed');
  const [outputs, setOutputs] = useState('{}');
  const [resolutionError, setResolutionError] = useState('');
  const [localResolutionError, setLocalResolutionError] = useState(false);
  const [jsonError, setJsonError] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = engine.refresh;

  async function loadInstances() {
    if (!run.instancesNextCursor || loadingInstances) return;

    setLoadingInstances(true);
    setInstanceError('');

    try {
      const page = await engineCall<Page<EngineInstance>>({
        op: 'instances',
        runId: run.id,
        cursor: run.instancesNextCursor,
      });
      setExpanded({
        id: run.id,
        updatedAt: run.updatedAt,
        instances: [...(extra?.instances ?? []), ...page.items],
        cursor: page.nextCursor,
      });
    } catch (error) {
      setInstanceError(engineError(error).message);
    } finally {
      setLoadingInstances(false);
    }
  }

  useEffect(() => {
    let stopped = false;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setEvents([]);
    if (!engine.info) {
      setStream('Disconnected · cached run');
      return;
    }
    void storedEvents(run.id)
      .then((events) => {
        if (!stopped)
          setEvents((current) =>
            eventWindow([
              ...events,
              ...current.filter((event) => !events.some((saved) => saved.id === event.id)),
            ]),
          );
      })
      .catch(() => {});
    // Completed runs still need their authoritative history when opened on a new client.
    void watchRun(run.id, (message) => {
      if (stopped) return;
      if (message.type === 'connection')
        setStream(message.message ? `${message.status} · ${message.message}` : message.status);
      else {
        setEvents((events) =>
          events.some((event) => event.id === message.event.id)
            ? events
            : eventWindow([...events, message.event]),
        );
        // Token and tool observations update the inspector directly. Projection events
        // trigger authoritative snapshots without refetching every catalog on each token.
        const observation = /^(model|tool|agent|output)\./.test(message.event.type);
        if (!observation && !timer)
          timer = setTimeout(() => {
            timer = undefined;
            void refresh();
          }, 200);
      }
    })
      .then((cancel) => {
        if (stopped) cancel();
        else stop = cancel;
      })
      .catch((error) => {
        if (!stopped) setStream(engineError(error).message);
      });
    return () => {
      stopped = true;
      stop?.();
      if (timer) clearTimeout(timer);
    };
  }, [run.id, engine.info, refresh]);

  async function act(op: 'cancel' | 'resume') {
    setBusy(true);

    try {
      await engine.command({ op, runId: run.id, operationId: crypto.randomUUID() });
    } catch {
      /* Toast contains the engine response. */
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    setBusy(true);
    setResolutionError('');
    setLocalResolutionError(false);
    setJsonError(false);
    let localFailure = false;

    try {
      const values = outcome === 'succeeded' ? JSON.parse(outputs) : {};
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        localFailure = true;
        throw new Error('Resolution outputs must be an object.');
      }
      await engine.command({
        op: 'resolve',
        runId: run.id,
        instanceId: resolution,
        resolution: { outcome, evidence, ...(outcome === 'succeeded' ? { outputs: values } : {}) },
        operationId: crypto.randomUUID(),
      });
      setResolution('');
    } catch (error) {
      setResolutionError(engineError(error).message);
      setLocalResolutionError(localFailure);
      setJsonError(error instanceof SyntaxError);
    } finally {
      setBusy(false);
    }
  }

  const connectionStatus = stream.split(' · ')[0];
  const streamLabel =
    stream === 'Connecting…' || stream === 'Disconnected · cached run'
      ? message(stream)
      : ['connected', 'reconnecting'].includes(connectionStatus)
        ? `${t(executionConnectionLabels[connectionStatus] ?? connectionStatus)}${stream.slice(connectionStatus.length)}`
        : stream;

  return (
    <div className="run-detail h-full flex flex-col min-h-0">
      <div className="run-heading flex items-center justify-between mt-5.25 mb-0 mx-7.5">
        <button type="button" className="text-button" onClick={onBack}>
          <ArrowLeft size={15} />
          {t('execution.allEngineRuns')}
        </button>
        <span className="type-label inline-flex text-[10px] text-secondary bg-[rgb(var(--overlay-rgb)_/_0.016)] border border-solid border-line-strong rounded-[30px] px-2 py-1.25">
          {t('execution.engineRun')}
        </span>
      </div>
      <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <h1>{run.title}</h1>
          <p>
            {run.id} · {run.profile} · {time(run.createdAt, locale)}
          </p>
        </div>
        <div className="heading-actions flex items-center gap-2.5">
          <Status status={run.status} />
          {engine.requests.some(
            (request) => request.runId === run.id && request.status === 'open',
          ) ? (
            <button type="button" className="button primary" onClick={onReview}>
              {t('execution.reviewRequest')}
            </button>
          ) : null}
          {run.availableActions
            .filter((action) => action !== 'resolve')
            .map((action) => (
              <button
                type="button"
                key={action}
                className="button"
                disabled={
                  !engine.info ||
                  busy ||
                  engine.pending.some(
                    (item) => 'runId' in item.request && item.request.runId === run.id,
                  )
                }
                onClick={() => void act(action as 'cancel' | 'resume')}
              >
                {action === 'cancel' ? <XCircle size={15} /> : <Play size={15} />}
                {t(executionActionLabels[action] ?? action)}
              </button>
            ))}
        </div>
      </header>
      <Diagnostics diagnostics={run.diagnostics} />
      {run.dataTruncated && <p role="status">{t('observe.dataTruncated')}</p>}
      {run.instancesNextCursor && (
        <p role="status">
          {t('observe.instancesPartial')}{' '}
          <button
            type="button"
            className="text-button"
            disabled={!engine.info || loadingInstances}
            onClick={() => void loadInstances()}
          >
            {t('observe.loadMoreInstances')}
          </button>
        </p>
      )}
      {instanceError && <p role="alert">{instanceError}</p>}
      <div className="underline-tabs flex border-b border-solid border-b-line gap-5.25 shrink-0 px-5.25 py-0">
        {[
          'graph',
          'replay',
          'compare',
          'instances',
          'timeline',
          'inputs',
          'outputs',
          'snapshot',
        ].map((tabName) => (
          <button
            type="button"
            key={tabName}
            className={tab === tabName ? 'active' : ''}
            onClick={() => setTab(tabName)}
          >
            {t(
              tabName === 'graph'
                ? 'observe.graph'
                : ['replay', 'compare'].includes(tabName)
                  ? `history.${tabName}`
                  : (executionTabLabels[tabName] ?? tabName),
            )}
          </button>
        ))}
      </div>
      <div
        className={`engine-run-content flex-1 min-h-50 overflow-auto mt-4 mb-5 mx-7.5 ${tab === 'graph' ? 'engine-observer-content overflow-hidden flex mt-3 min-h-75' : ''}`}
      >
        {tab === 'graph' ? (
          run.instancesNextCursor ? (
            <p role="status">{t('observe.graphNeedsInstances')}</p>
          ) : (
            <EngineExecutionView
              run={run}
              events={events}
              connection={streamLabel}
              connected={!!engine.info}
              onReview={onReview}
              onResolve={(id) => {
                setResolutionError('');
                setResolution(id);
              }}
            />
          )
        ) : tab === 'replay' ? (
          <EngineReplayView run={run} connected={!!engine.info} onLive={() => setTab('graph')} />
        ) : tab === 'compare' ? (
          <EngineCompareView key={run.id} run={run} runs={engine.runs} connected={!!engine.info} />
        ) : tab === 'snapshot' ? (
          <SourceEditor
            source={run.package.source}
            readOnly
            label={t('execution.engineImmutableSnapshot')}
          />
        ) : tab === 'timeline' ? (
          <EngineTimeline run={run} events={events} connection={streamLabel} />
        ) : tab === 'instances' ? (
          <div className="engine-instance-list grid gap-3">
            {run.instances.map((instance) => (
              <article key={instance.id}>
                <div className="inline-row spread flex items-center gap-2.5 justify-between">
                  <div>
                    <strong>{instance.nodeId}</strong>
                    <code>{instance.id}</code>
                    <small>
                      {instance.scope || t('execution.rootGraph')} ·{' '}
                      {instance.attemptId ?? t('execution.noAttempt')}
                    </small>
                  </div>
                  <Status status={instance.status} />
                </div>
                {instance.error ? <Diagnostics diagnostics={[instance.error]} /> : null}
                {instance.status === 'waiting_resolution' &&
                run.availableActions.includes('resolve') ? (
                  <button
                    type="button"
                    className="button"
                    disabled={!engine.info || busy}
                    onClick={() => {
                      setResolutionError('');
                      setResolution(instance.id);
                    }}
                  >
                    {t('execution.resolveUnknownOutcome')}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <pre className="json-view text-muted overflow-auto min-h-0 text-[11px] p-5.5 m-0">
            {JSON.stringify(
              tab === 'inputs'
                ? { values: run.inputs, artifacts: run.inputArtifacts }
                : { values: run.outputs, artifacts: run.artifacts },
              null,
              2,
            )}
          </pre>
        )}
      </div>
      {resolution ? (
        <Modal
          title={t('execution.resolveUnknownOutcome')}
          subtitle={t('execution.supplyEvidenceAboutTheExternalOperationTheEngine')}
          onClose={() => setResolution('')}
        >
          <div className="modal-body px-7.75 py-6.75">
            {resolutionError ? (
              <p
                className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
                role="alert"
              >
                {localResolutionError
                  ? t('execution.resolutionOutputsMustBeAnObject')
                  : jsonError
                    ? t('execution.invalidJsonMessage', { message: resolutionError })
                    : resolutionError}
              </p>
            ) : null}
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('execution.confirmedOutcome')}
              <select
                aria-label={t('execution.confirmedOutcome')}
                value={outcome}
                onChange={(event) => setOutcome(event.target.value as typeof outcome)}
              >
                <option value="failed">{t('execution.failed')}</option>
                <option value="not_started">{t('execution.confirmedNotStarted')}</option>
                <option value="succeeded">{t('execution.succeededWithVerifiedOutputs')}</option>
              </select>
            </label>
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('execution.evidence')}
              <textarea
                aria-label={t('execution.resolutionEvidence')}
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
              />
            </label>
            {outcome === 'succeeded' ? (
              <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                {t('execution.verifiedOutputPorts')}
                <textarea
                  aria-label={t('execution.resolutionOutputs')}
                  value={outputs}
                  onChange={(event) => setOutputs(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          <div className="modal-footer flex items-center justify-between gap-4 bg-surface border-t border-solid border-t-line px-7.75 py-5">
            <button
              type="button"
              className="button primary"
              disabled={
                !engine.info ||
                busy ||
                !evidence.trim() ||
                engine.pending.some(
                  (item) => item.request.op === 'resolve' && item.request.instanceId === resolution,
                )
              }
              onClick={() => void resolve()}
            >
              {t('execution.submitResolution')}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
