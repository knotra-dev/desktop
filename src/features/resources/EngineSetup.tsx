import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { desktop } from '../../lib/native';
import {
  cancelSetup,
  openDependency,
  type SetupStatus,
  setupStatus,
  startDesktopEngine,
} from '../../lib/setup';

export default function EngineSetup({
  onReady,
  onStopped,
  connectedUrl,
}: {
  onReady: (endpoint: string) => Promise<void>;
  onStopped: (endpoint: string | undefined) => Promise<void>;
  connectedUrl?: string;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<SetupStatus>();
  const [action, setAction] = useState<'start' | 'stop'>();
  const [error, setError] = useState('');
  const active = useRef(true);
  const ownsStart = useRef(false);
  const receive = useCallback(
    async (next: SetupStatus) => {
      if (!active.current) return;
      setStatus(next);
      if (next.phase === 'starting') return;
      if (next.phase === 'error')
        throw new Error(next.error || next.message || t('modelSetup.failed'));
      if (ownsStart.current) {
        if (next.phase !== 'ready' || !next.endpoint) throw new Error(t('modelSetup.notReady'));
        await onReady(next.endpoint);
        ownsStart.current = false;
        if (active.current) setAction(undefined);
        window.dispatchEvent(new Event('knotra-engine-changed'));
      }
    },
    [onReady, t],
  );

  useEffect(() => {
    active.current = true;
    if (!desktop) return;
    function refresh() {
      void setupStatus()
        .then(receive)
        .catch((error) => {
          if (active.current) {
            ownsStart.current = false;
            setError(String(error));
            setAction(undefined);
          }
        });
    }
    refresh();
    window.addEventListener('knotra-connections-changed', refresh);
    window.addEventListener('knotra-engine-changed', refresh);
    return () => {
      active.current = false;
      window.removeEventListener('knotra-connections-changed', refresh);
      window.removeEventListener('knotra-engine-changed', refresh);
    };
  }, [receive]);

  useEffect(() => {
    if (
      status?.phase !== 'starting' &&
      !['pending', 'applying', 'error'].includes(status?.sourcesState ?? '')
    )
      return;
    let subscribed = true;
    const timer = window.setTimeout(() => {
      void setupStatus()
        .then((next) => {
          if (subscribed) return receive(next);
        })
        .catch((error) => {
          if (subscribed) {
            ownsStart.current = false;
            setError(String(error));
            setAction(undefined);
          }
        });
    }, 1000);
    return () => {
      subscribed = false;
      window.clearTimeout(timer);
    };
  }, [status, receive]);

  async function start() {
    setAction('start');
    setError('');
    ownsStart.current = true;

    try {
      window.dispatchEvent(new Event('knotra-engine-start-requested'));
      const next = await startDesktopEngine();
      window.dispatchEvent(new Event('knotra-engine-changed'));
      await receive(next);
    } catch (error) {
      ownsStart.current = false;
      if (active.current) {
        setError(String(error));
        setAction(undefined);
      }
    }
  }

  async function stop() {
    setAction('stop');
    setError('');
    ownsStart.current = false;
    const previousEndpoint = status?.endpoint;

    try {
      const next = await cancelSetup();
      if (active.current) setStatus(next);
      await onStopped(previousEndpoint);
      window.dispatchEvent(new Event('knotra-engine-changed'));
    } catch (error) {
      if (active.current) setError(String(error));
    } finally {
      if (active.current) setAction(undefined);
    }
  }

  if (!desktop) return null;

  const starting = status?.phase === 'starting';
  const running = status?.phase === 'ready';
  const hasSources = !!(status?.connections?.length || status?.mcpConnections?.length);

  return (
    <section
      className="settings-card engine-setup max-w-250 border border-solid border-line rounded-[20px] bg-surface mb-6 p-7.5"
      data-tour="local-engine"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2>{t('engineSetup.title')}</h2>
        <span className={`status status-${running ? 'succeeded' : 'pending'}`}>
          <span />
          {t(
            starting
              ? 'engineSetup.starting'
              : running
                ? 'engineSetup.running'
                : 'engineSetup.stopped',
          )}
        </span>
      </div>
      <p className="text-[12px] text-secondary max-w-[70ch] mt-2">{t('engineSetup.intro')}</p>
      <p className="text-[12px] text-secondary max-w-[70ch] mt-2">{t('engineSetup.automatic')}</p>
      {!hasSources ? (
        <p className="text-[12px] text-secondary mt-3">{t('engineSetup.noSources')}</p>
      ) : null}
      {status && !status.dockerReady ? (
        <div className="flex flex-wrap items-center gap-3 mt-4">
          <p className="text-[12px] text-secondary">{t('modelSetup.dockerHint')}</p>
          <button
            type="button"
            className="button"
            disabled={!!action || starting}
            onClick={() => {
              void openDependency('docker')
                .then(() => setupStatus())
                .then(setStatus)
                .catch((error) => setError(String(error)));
            }}
          >
            {t('modelSetup.openDocker')}
          </button>
        </div>
      ) : null}
      {status?.sourcesState && status.sourcesState !== 'current' ? (
        <p className="text-[12px] text-secondary max-w-[70ch] mt-3" role="status">
          {t(
            status.sourcesState === 'pending'
              ? 'engineSetup.sourcesPending'
              : status.sourcesState === 'applying'
                ? 'engineSetup.sourcesApplying'
                : 'engineSetup.sourcesFailed',
          )}
        </p>
      ) : null}
      {status?.sourceApplyError ? (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {status.sourceApplyError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 mt-5">
        {running && status?.endpoint && status.endpoint !== connectedUrl ? (
          <button
            type="button"
            className="button primary"
            disabled={!!action}
            onClick={() => {
              if (!status.endpoint) return;
              window.dispatchEvent(new Event('knotra-engine-start-requested'));
              void onReady(status.endpoint).catch((error) => setError(String(error)));
            }}
          >
            {t('engineSetup.useLocal')}
          </button>
        ) : null}
        {running || starting ? (
          <button
            type="button"
            className="button"
            disabled={action === 'stop'}
            onClick={() => void stop()}
          >
            {t('engineSetup.stop')}
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={!!action || !hasSources}
            onClick={() => void start()}
          >
            {t(action === 'start' ? 'engineSetup.starting' : 'engineSetup.start')}
          </button>
        )}
      </div>
      {error || status?.error ? (
        <p role="alert" className="form-error text-secondary text-[12px] mt-4 whitespace-pre-wrap">
          {error || status?.error}
        </p>
      ) : null}
      {status?.sourceError ? (
        <p role="alert" className="form-error text-secondary text-[12px] mt-4 whitespace-pre-wrap">
          {status.sourceError}
        </p>
      ) : null}
    </section>
  );
}
