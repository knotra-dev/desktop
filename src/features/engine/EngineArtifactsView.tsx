import { Download, FileBox, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, size } from '../../components/ui';
import { base64, decodeText } from '../../lib/bytes';
import { downloadArtifact, engineError, exportEngineArtifact } from '../../lib/engine/client';
import type { EngineController } from '../../lib/engine/useEngine';
import { useI18n } from '../../lib/i18n';

export function EngineArtifactsView({ engine }: { engine: EngineController }) {
  const { t, locale, message } = useI18n();
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState('');
  const [previewNotice, setPreviewNotice] = useState('');
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [exportError, setExportError] = useState('');
  const [localError, setLocalError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const files = engine.artifacts.filter((artifact) =>
    `${artifact.name} ${artifact.id} ${artifact.origin.runId ?? ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const artifact = files.find((artifact) => artifact.id === selected);
  const artifactId = artifact?.id;
  useEffect(() => {
    let current = true;
    setPreview('');
    setPreviewNotice('');
    setError('');
    setExportError('');
    setBusy(false);
    if (artifactId && !engine.info)
      setPreviewNotice('Reconnect to the engine to verify and preview these bytes.');
    if (artifactId && engine.info) {
      setBusy(true);
      void downloadArtifact(artifactId)
        .then((result) => {
          if (current) {
            try {
              setPreview(decodeText(result.content));
            } catch {
              setPreviewNotice('Binary artifact. Export to inspect the preserved bytes.');
            }
          }
        })
        .catch((error) => {
          if (current) {
            setError(engineError(error).message);
          }
        })
        .finally(() => {
          if (current) setBusy(false);
        });
    }
    return () => {
      current = false;
    };
  }, [artifactId, engine.info]);
  return (
    <section className="page pb-8.75 min-h-full">
      <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <h1>{t('execution.engineArtifacts')}</h1>
          <p>{t('execution.registeredImmutableFilesWithCheckedSizesHashesAnd')}</p>
        </div>
        <label className="button">
          {t('execution.uploadInputFile')}
          <input
            hidden
            type="file"
            disabled={!engine.info}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setUploadError('');
              setLocalError(false);
              let localFailure = false;
              try {
                if (file.size > 64 * 1024 * 1024) {
                  localFailure = true;
                  throw new Error('Artifact exceeds 64 MiB.');
                }
                await engine.command({
                  op: 'upload',
                  file: {
                    path: file.name,
                    content: base64(new Uint8Array(await file.arrayBuffer())),
                  },
                  mediaType: file.type || 'application/octet-stream',
                  operationId: crypto.randomUUID(),
                });
              } catch (error) {
                setUploadError(engineError(error).message);
                setLocalError(localFailure);
              }
            }}
            aria-label={t('execution.uploadEngineArtifact')}
          />
        </label>
      </header>
      <div className="list-toolbar flex items-center justify-between gap-5 mb-5">
        <label className="search-field flex items-center gap-3 text-secondary border border-solid border-line rounded-[16px] w-100 bg-surface px-4.5 py-0">
          <Search size={16} />
          <input
            aria-label={t('execution.searchEngineArtifacts')}
            placeholder={t('execution.searchFiles')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {uploadError ? (
        <p
          className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
          role="alert"
        >
          {localError ? t('execution.artifactExceeds64Mib') : uploadError}
        </p>
      ) : null}
      {files.length ? (
        <div className="artifact-layout flex gap-5.75 items-start">
          <div className="artifact-grid grid grid-cols-[repeat(auto-fill,_minmax(205px,_1fr))] gap-4.5 flex-1">
            {files.map((file) => (
              <button
                type="button"
                key={file.id}
                className={`artifact-card border border-solid border-line rounded-[20px] bg-surface overflow-hidden text-left flex flex-col p-0 ${selected === file.id ? 'selected' : ''}`}
                onClick={() => setSelected(file.id)}
              >
                <div className="artifact-thumbnail h-38.75 w-full flex items-center justify-center [background:radial-gradient(ellipse_at_50%_40%,_rgb(var(--accent-rgb)_/_0.173),_transparent_70%),_linear-gradient(130deg,_var(--surface),_var(--base))] text-muted relative">
                  <FileBox size={36} />
                </div>
                <div className="artifact-info flex flex-col gap-2.5 p-4.75">
                  <strong>{file.name}</strong>
                  <span>{file.origin.runId ?? t('execution.uploadedInput')}</span>
                  <small>
                    {size(file.size, locale)} · {file.mediaType}
                  </small>
                </div>
              </button>
            ))}
          </div>
          {artifact ? (
            <aside className="artifact-inspector w-80 min-w-0 shrink-0 border border-solid border-line rounded-[12px] bg-surface p-5.5">
              <div className="inline-row spread flex items-center gap-2.5 justify-between">
                <h3>{artifact.name}</h3>
                <button
                  type="button"
                  className="button small-button text-[11px] min-h-8 px-3 py-1.75"
                  disabled={!engine.info || busy || exporting || !!error}
                  onClick={() => {
                    setExportError('');
                    setExporting(true);
                    void exportEngineArtifact(artifact.id)
                      .catch((error) => setExportError(engineError(error).message))
                      .finally(() => setExporting(false));
                  }}
                >
                  <Download size={14} />
                  {t('common.export')}
                </button>
              </div>
              {error || exportError ? (
                <p
                  className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
                  role="alert"
                >
                  {error || exportError}
                </p>
              ) : null}
              <div className="detail-field flex flex-col gap-2.25 mb-5.75">
                <span>SHA-256</span>
                <code className="hash text-[10px]! leading-[1.9]">{artifact.sha256}</code>
              </div>
              <div className="detail-field flex flex-col gap-2.25 mb-5.75">
                <span>{t('execution.origin')}</span>
                <code>{JSON.stringify(artifact.origin, null, 2)}</code>
              </div>
              <pre className="artifact-text text-[11px] text-muted mt-6.25 mb-0 border-t border-solid border-t-line pt-5.25 leading-[1.9] mx-0">
                {busy
                  ? t('execution.verifyingBytes')
                  : previewNotice
                    ? message(previewNotice)
                    : preview}
              </pre>
            </aside>
          ) : null}
        </div>
      ) : (
        <Empty icon={<FileBox />} title={t('execution.noEngineArtifacts')}>
          {t('execution.uploadInputFilesOrInspectDeclaredOutputsFrom')}
        </Empty>
      )}
    </section>
  );
}
