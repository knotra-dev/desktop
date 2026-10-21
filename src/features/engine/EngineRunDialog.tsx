import { Play } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Modal, size } from '../../components/ui';
import { engineError } from '../../lib/engine/client';
import { enginePackage } from '../../lib/engine/package';
import type { EngineDiagnostic, EngineRun } from '../../lib/engine/types';
import type { EngineController } from '../../lib/engine/useEngine';
import { useI18n } from '../../lib/i18n';
import type { Workspace } from '../../lib/types';
import { parsePipeline } from '../../lib/validation';
import { Diagnostics } from './EngineDiagnostics';

export function EngineRunDialog({
  workspace,
  engine,
  onClose,
  onStarted,
}: {
  workspace: Workspace;
  engine: EngineController;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const { t, locale, message } = useI18n();
  const pipeline = parsePipeline(workspace.source);
  const artifactInputId = useId();
  const [profile, setProfile] = useState(engine.profiles[0]?.id ?? '');
  const [inputs, setInputs] = useState(() =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(pipeline?.spec.inputs ?? {})
          .filter(([, port]) => !port.artifact && 'default' in port)
          .map(([name, port]) => [name, port.default]),
      ),
      null,
      2,
    ),
  );
  const [handles, setHandles] = useState<Record<string, string | string[]>>({});
  const [artifactText, setArtifactText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [localError, setLocalError] = useState<{
    phrase: string;
    params?: Record<string, string | number>;
  }>();
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostic[]>([]);
  const [validated, setValidated] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const frozen = useRef<{ definitionId?: string; startId: string; publishId: string } | undefined>(
    undefined,
  );

  async function check(start: boolean) {
    setBusy(true);
    setError('');
    setLocalError(undefined);
    let localFailure: typeof localError;

    try {
      const values = JSON.parse(inputs);
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        localFailure = { phrase: 'Inputs must be a JSON object.' };
        throw new Error('Inputs must be a JSON object.');
      }

      const artifactBindings = { ...handles };
      for (const [name, port] of Object.entries(pipeline?.spec.inputs ?? {}))
        if (port.artifact?.collection) {
          const value = JSON.parse(artifactText[name] ?? '[]');
          if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id.length)) {
            localFailure = {
              phrase: '{name} requires an array of registered artifact IDs.',
              params: { name },
            };
            throw new Error(`${name} requires an array of registered artifact IDs.`);
          }
          artifactBindings[name] = value;
        }

      const pack = enginePackage(workspace);
      const admission = await engine.command<{ valid: boolean; diagnostics: EngineDiagnostic[] }>({
        op: 'validate',
        package: pack,
        profile,
        inputs: values,
        artifacts: artifactBindings,
      });

      setDiagnostics(admission.diagnostics);
      setValidated(admission.valid);
      if (!admission.valid || !start) return;

      frozen.current ??= { startId: crypto.randomUUID(), publishId: crypto.randomUUID() };
      let definitionId = frozen.current.definitionId;
      if (!definitionId) {
        const { definition } = await engine.command<{ definition: { id: string } }>({
          op: 'publish',
          package: pack,
          operationId: frozen.current.publishId,
        });
        definitionId = definition.id;
        frozen.current.definitionId = definitionId;
      }

      const { run } = await engine.command<{ run: EngineRun }>({
        op: 'start',
        definitionId,
        profile,
        inputs: values,
        artifacts: artifactBindings,
        operationId: frozen.current.startId,
      });

      onStarted(run.id);
      onClose();
    } catch (error) {
      const caught = engineError(error);
      setError(caught.message);
      setLocalError(
        error instanceof SyntaxError
          ? { phrase: 'Invalid JSON: {message}', params: { message: caught.message } }
          : localFailure,
      );
      setDiagnostics(caught.diagnostics as EngineDiagnostic[]);
      if (start && frozen.current) {
        if (
          caught.code === 'input' ||
          (caught.status &&
            caught.status >= 400 &&
            caught.status < 500 &&
            ![408, 429].includes(caught.status))
        ) {
          // A definitive rejection has no pending command to reconcile.
          frozen.current = undefined;
          setBlocked(false);
        } else setBlocked(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('execution.runOnEngine')}
      subtitle={t('execution.theEngineChecksAdmissionAndFixesAnImmutable')}
      onClose={onClose}
    >
      <div className="modal-body engine-run-form max-h-[65vh] overflow-auto px-7.75 py-6.75">
        <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
          {t('execution.engineProfile')}
          <select
            aria-label={t('execution.engineProfile')}
            value={profile}
            onChange={(event) => {
              setValidated(false);
              setProfile(event.target.value);
            }}
          >
            {!engine.profiles.length ? (
              <option value="">{t('execution.noProfilesAvailable')}</option>
            ) : (
              engine.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.title} · {profile.revision}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
          {t('execution.workflowValuesJson')}
          <textarea
            aria-label={t('execution.workflowInputValues')}
            className="code-input [font-family:ui-monospace,_monospace]"
            rows={7}
            value={inputs}
            onChange={(event) => {
              setValidated(false);
              setInputs(event.target.value);
            }}
          />
        </label>
        <p className="small muted text-[11px] text-muted">
          {t('execution.inputPortsPortsOmittedDefaultsAreSuppliedBy', {
            ports:
              Object.entries(pipeline?.spec.inputs ?? {})
                .filter(([, port]) => !port.artifact)
                .map(([name, port]) =>
                  port.required ? t('execution.nameRequired', { name }) : name,
                )
                .join(', ') || t('execution.none'),
          })}
        </p>
        {Object.entries(pipeline?.spec.inputs ?? {})
          .filter(([, port]) => port.artifact)
          .map(([name, port]) => (
            <label
              className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6"
              key={name}
              htmlFor={`${artifactInputId}-${name}`}
            >
              {t('execution.nameInputArtifact', { name })}
              {port.artifact?.collection ? (
                <textarea
                  id={`${artifactInputId}-${name}`}
                  aria-label={t('execution.artifactHandlesForName', { name })}
                  placeholder='["artifact-id"]'
                  value={artifactText[name] ?? '[]'}
                  onChange={(event) => {
                    setValidated(false);
                    setArtifactText((current) => ({ ...current, [name]: event.target.value }));
                  }}
                />
              ) : (
                <select
                  id={`${artifactInputId}-${name}`}
                  aria-label={t('execution.artifactHandleForName', { name })}
                  value={String(handles[name] ?? '')}
                  onChange={(event) => {
                    setValidated(false);
                    setHandles((current) => {
                      const next = { ...current };
                      if (event.target.value) next[name] = event.target.value;
                      else delete next[name];
                      return next;
                    });
                  }}
                >
                  <option value="">{t('execution.chooseARegisteredArtifact')}</option>
                  {engine.artifacts
                    .filter((artifact) =>
                      port.artifact?.mediaTypes.some(
                        (type) =>
                          type === artifact.mediaType ||
                          type === '*/*' ||
                          (type.endsWith('/*') && artifact.mediaType.startsWith(type.slice(0, -1))),
                      ),
                    )
                    .map((artifact) => (
                      <option key={artifact.id} value={artifact.id}>
                        {artifact.name} · {size(artifact.size, locale)}
                      </option>
                    ))}
                </select>
              )}
            </label>
          ))}
        {error ? (
          <p
            className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
            role="alert"
          >
            {localError ? message(localError.phrase, localError.params) : error}
          </p>
        ) : null}
        {blocked ? (
          <div className="notice small text-[11px] flex items-start gap-3 border border-solid border-line-strong rounded-[16px] bg-[rgb(var(--accent-rgb)_/_0.027)] text-accent mb-6.25 px-5 py-4.5">
            {t('execution.thisCommandHasASavedOperationIdClose')}
          </div>
        ) : null}
        <Diagnostics diagnostics={diagnostics} />
        {validated ? (
          <p className="small text-[11px]">
            {t('execution.engineAdmissionChecksPassedStartChecksAgainBefore')}
          </p>
        ) : null}
      </div>
      <div className="modal-footer flex items-center justify-between gap-4 bg-surface border-t border-solid border-t-line px-7.75 py-5">
        <button
          type="button"
          className="button"
          disabled={busy || !profile || blocked}
          onClick={() => void check(false)}
        >
          {t('execution.checkWithEngine')}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={
            busy ||
            !profile ||
            blocked ||
            engine.pending.some((item) => ['publish', 'start'].includes(item.request.op))
          }
          onClick={() => void check(true)}
        >
          <Play size={15} />
          {busy ? t('execution.preparing') : t('execution.startRun')}
        </button>
      </div>
    </Modal>
  );
}
