import { Download, FileBox } from 'lucide-react';
import { useState } from 'react';
import { size } from '../../../components/ui';
import { engineError, exportEngineArtifact } from '../../../lib/engine/client';
import type { EngineRun } from '../../../lib/engine/types';
import { useI18n } from '../../../lib/i18n';

export function ArtifactCard({
  artifact,
  connected,
}: {
  artifact: EngineRun['artifacts'][number];
  connected: boolean;
}) {
  const { t, locale } = useI18n();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="execution-artifact flex items-center gap-2.25 mb-2 border border-solid border-line rounded-[7px] p-2.5">
      <FileBox size={16} />
      <span>
        <strong>{artifact.name}</strong>
        <small>
          {artifact.mediaType} · {size(artifact.size, locale)}
        </small>
        {error ? (
          <small className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap">
            {error}
          </small>
        ) : null}
      </span>
      <button
        type="button"
        className="icon-button"
        disabled={!connected || busy}
        aria-label={t('observe.downloadArtifact', { name: artifact.name })}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await exportEngineArtifact(artifact.id);
          } catch (error) {
            setError(engineError(error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download size={15} />
      </button>
    </div>
  );
}
