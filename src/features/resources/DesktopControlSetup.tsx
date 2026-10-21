import { invoke } from '@tauri-apps/api/core';
import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { desktop } from '../../lib/native';

interface ControlStatus {
  protocol: string;
  available: boolean;
  frontendReady: boolean;
  config?: Record<string, unknown>;
  error?: string;
}

export default function DesktopControlSetup() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ControlStatus>();
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!desktop) return;

    let active = true;
    void invoke<ControlStatus>('desktop_control_status')
      .then((value) => {
        if (!active) return;
        if (value?.protocol !== 'knotra.desktop-control/1')
          throw new Error(t('desktopControl.unavailable'));
        setStatus(value);
      })
      .catch(() => {
        if (active) setError(t('desktopControl.unavailable'));
      });
    return () => {
      active = false;
    };
  }, [t]);

  if (!desktop) return null;

  const config = status?.config ? JSON.stringify(status.config, null, 2) : '';

  return (
    <section
      className="settings-card desktop-control max-w-250 rounded-[20px] border border-solid border-line bg-surface mb-6 p-7.5"
      aria-label={t('desktopControl.title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2>{t('desktopControl.title')}</h2>
        <span className="text-[11px] text-secondary">
          {t(
            status?.available && status.frontendReady
              ? 'desktopControl.ready'
              : 'desktopControl.unavailable',
          )}
        </span>
      </div>
      <p className="mt-2 max-w-[70ch] text-[12px] leading-relaxed text-secondary">
        {t('desktopControl.help')}
      </p>
      <p className="mt-3 max-w-[70ch] text-[12px] leading-relaxed text-muted">
        {t('desktopControl.appOpen')}
      </p>
      {config ? (
        <details className="mt-5 border-t border-solid border-line pt-4">
          <summary className="cursor-pointer text-[12px] text-secondary">
            {t('desktopControl.configuration')}
          </summary>
          <p className="mt-3 text-[12px] leading-relaxed text-muted">
            {t('desktopControl.configurationHelp')}
          </p>
          <textarea
            readOnly
            aria-label={t('desktopControl.configuration')}
            value={config}
            rows={8}
            spellCheck={false}
            className="mt-3 w-full resize-y rounded-[10px] border border-solid border-line bg-base p-3 text-[11px] leading-relaxed font-mono"
            onFocus={(event) => event.target.select()}
          />
          <button
            type="button"
            className="button mt-3"
            onClick={() => {
              if (!navigator.clipboard) {
                setError(t('desktopControl.copyHelp'));
                return;
              }
              void navigator.clipboard
                .writeText(config)
                .then(() => setCopied(true))
                .catch(() => setError(t('desktopControl.copyHelp')));
            }}
          >
            <Copy size={14} /> {t(copied ? 'desktopControl.copied' : 'desktopControl.copy')}
          </button>
        </details>
      ) : null}
      {error || status?.error ? (
        <p role="alert" className="mt-3 text-[12px] leading-relaxed text-secondary">
          {error || status?.error}
        </p>
      ) : null}
    </section>
  );
}
