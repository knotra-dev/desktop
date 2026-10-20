import { Validator } from '@cfworker/json-schema';
import { Inbox } from 'lucide-react';
import { type Dispatch, type SetStateAction, useState } from 'react';
import { Empty, time } from '../../components/ui';
import { engineError } from '../../lib/engine/client';
import type { EngineRequest } from '../../lib/engine/types';
import type { EngineController } from '../../lib/engine/useEngine';
import { useI18n } from '../../lib/i18n';
import { ReviewArtifact } from './ReviewArtifact';

export function EngineInboxView({
  engine,
  onRun,
  responseDrafts,
  onResponseDraftsChange,
}: {
  engine: EngineController;
  onRun: (id: string) => void;
  responseDrafts?: Record<string, string>;
  onResponseDraftsChange?: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const { t, locale } = useI18n();
  const [selected, setSelected] = useState('');
  const [localDrafts, setLocalDrafts] = useState<Record<string, string>>({});
  const drafts = responseDrafts ?? localDrafts;
  const setDrafts = onResponseDraftsChange ?? setLocalDrafts;
  const requests = engine.requests.filter((request) => request.status === 'open');
  const request = requests.find((request) => request.id === selected) ?? requests[0];
  const requestName = (item: EngineRequest) =>
    engine.runs
      .find((run) => run.id === item.runId)
      ?.instances.find((instance) => instance.id === item.instanceId)?.nodeId ??
    t('execution.humanRequest');
  const runTitle = (item: EngineRequest) =>
    engine.runs.find((run) => run.id === item.runId)?.title ?? item.runId;
  return (
    <section className="page inbox-page pb-8.75 min-h-full">
      <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <h1>{t('execution.engineInbox')}</h1>
          <p>{t('execution.eachResponseIsAddressedToASavedRequest')}</p>
        </div>
        <span className="count-pill text-[10px] text-muted border border-solid border-line bg-surface rounded-[6px] px-2.75 py-2">
          {t('execution.countOpenRequests', { count: requests.length })}
        </span>
      </header>
      {request ? (
        <div className="inbox-layout flex gap-6.25 mx-7.5 my-0">
          <div className="request-list w-58.75 shrink-0">
            {requests.map((item) => (
              <button
                type="button"
                key={item.id}
                className={request.id === item.id ? 'active' : ''}
                aria-pressed={request.id === item.id}
                onClick={() => setSelected(item.id)}
              >
                <Inbox size={17} />
                <strong>{requestName(item)}</strong>
                <small>{runTitle(item)}</small>
                <time>{time(item.createdAt, locale)}</time>
              </button>
            ))}
          </div>
          <EngineResponse
            key={request.id}
            request={request}
            title={requestName(request)}
            runTitle={runTitle(request)}
            engine={engine}
            onRun={onRun}
            value={drafts[request.id] ?? '{}'}
            onChange={(value) => setDrafts((current) => ({ ...current, [request.id]: value }))}
            onSubmitted={(value) =>
              setDrafts((current) => {
                if (current[request.id] !== value) return current;
                const next = { ...current };
                delete next[request.id];
                return next;
              })
            }
          />
        </div>
      ) : (
        <Empty icon={<Inbox />} title={t('execution.noOpenEngineRequests')}>
          {t('execution.savedHumanRequestsAppearHereWhenTheEngine')}
        </Empty>
      )}
    </section>
  );
}

function EngineResponse({
  request,
  title,
  runTitle,
  engine,
  onRun,
  value,
  onChange,
  onSubmitted,
}: {
  request: EngineRequest;
  title: string;
  runTitle: string;
  engine: EngineController;
  onRun: (id: string) => void;
  value: string;
  onChange: (value: string) => void;
  onSubmitted: (value: string) => void;
}) {
  const { t, locale, message } = useI18n();
  const [error, setError] = useState('');
  const [localError, setLocalError] = useState('');
  const [jsonError, setJsonError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (request.responseSchema === null) return;
    setError('');
    setLocalError('');
    setJsonError(false);
    setBusy(true);
    let localFailure = '';
    try {
      const outputs = JSON.parse(value);
      if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
        localFailure = 'Response must be an object of output ports.';
        throw new Error('Response must be an object of output ports.');
      }
      if (!new Validator(request.responseSchema, '2020-12', false).validate(outputs).valid) {
        localFailure = 'Response does not match the requested JSON schema.';
        throw new Error('Response does not match the requested JSON schema.');
      }
      await engine.command({
        op: 'respond',
        requestId: request.id,
        outputs,
        operationId: crypto.randomUUID(),
      });
      onSubmitted(value);
    } catch (error) {
      setError(engineError(error).message);
      setLocalError(localFailure);
      setJsonError(error instanceof SyntaxError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="review-card flex-1 min-w-0 bg-surface border border-solid border-line rounded-[20px] overflow-hidden">
      <header>
        <div>
          <span className="eyebrow text-[9px] tracking-[1.3px] text-muted font-medium">
            {t('execution.humanRequest')}
          </span>
          <h2>{title}</h2>
          <p className="small muted text-[11px] text-muted">{runTitle}</p>
        </div>
        <button type="button" className="text-button" onClick={() => onRun(request.runId)}>
          {t('execution.viewRun')}
        </button>
      </header>
      <div className="review-content flex flex-col gap-4.5 min-w-0 px-6.75 py-6">
        <p className="review-prompt text-[11px] text-muted whitespace-pre-wrap wrap-anywhere mx-6.75 my-5.25">
          {request.prompt}
        </p>
        {request.dataTruncated && <p role="status">{t('observe.dataTruncated')}</p>}
        {request.responseSchema === null && (
          <p role="status">{t('execution.schemaPreviewUnavailable')}</p>
        )}
        <p className="small muted text-[11px] text-muted">
          {t('execution.deadlineTime', { time: time(request.deadline, locale) })}
        </p>
        {Object.entries(request.inputs.artifacts ?? {}).flatMap(([name, value]) =>
          (Array.isArray(value) ? value : [value]).map((artifact, index) => (
            <ReviewArtifact
              key={`${artifact.id}/${artifact.sha256}`}
              name={Array.isArray(value) ? `${name}[${index}]` : name}
              artifact={artifact}
              connected={!!engine.info}
            />
          )),
        )}
        <details>
          <summary>{t('execution.inputs')}</summary>
          <pre className="json-view text-muted overflow-auto min-h-0 text-[11px] p-5.5 m-0">
            {JSON.stringify(request.inputs, null, 2)}
          </pre>
        </details>
        <details>
          <summary>{t('execution.responseSchema')}</summary>
          <pre className="json-view text-muted overflow-auto min-h-0 text-[11px] p-5.5 m-0">
            {request.responseSchemaJSON ?? JSON.stringify(request.responseSchema, null, 2)}
          </pre>
        </details>
      </div>
      <div className="response-form bg-surface border-t border-solid border-t-line px-6.75 py-5.75">
        <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
          {t('execution.responseOutputPorts')}
          <textarea
            aria-label={t('execution.engineReviewResponse')}
            className="code-input [font-family:ui-monospace,_monospace]"
            rows={7}
            value={value}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        {error ? (
          <p
            className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
            role="alert"
          >
            {localError
              ? message(localError)
              : jsonError
                ? t('execution.invalidJsonMessage', { message: error })
                : error}
          </p>
        ) : null}
        <div className="response-footer flex items-center justify-between gap-3.75 mt-4.25">
          <small>{t('execution.requestId', { id: request.id })}</small>
          <button
            type="button"
            className="button primary"
            disabled={
              !engine.info ||
              request.responseSchema === null ||
              busy ||
              engine.pending.some(
                (item) => item.request.op === 'respond' && item.request.requestId === request.id,
              )
            }
            onClick={() => void submit()}
          >
            {t('execution.submitResponse')}
          </button>
        </div>
      </div>
    </div>
  );
}
