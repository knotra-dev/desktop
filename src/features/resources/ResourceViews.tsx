import {
  ArrowUpRight,
  Bot,
  Box,
  Check,
  ChevronRight,
  ExternalLink,
  Globe,
  KeyRound,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { Empty } from '../../components/ui';
import type { EngineController } from '../../lib/engine/useEngine';
import { type Locale, type MessageKey, useI18n } from '../../lib/i18n';
import { openProjectDocs } from '../../lib/native';
import type { Theme } from '../../lib/theme';
import type { Pipeline } from '../../lib/types';
import { record } from '../../lib/types';

export function ConnectionsView({
  pipeline,
  onSource,
  engine,
}: {
  engine: EngineController;
  pipeline?: Pipeline;
  onSource: (kind: 'models' | 'mcp' | 'sandboxes' | 'secrets') => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'models' | 'mcp' | 'sandboxes' | 'secrets'>('models');
  const meta = {
    models: { title: t('resources.models'), empty: 'resources.noModelsDeclared', icon: Bot },
    mcp: { title: t('resources.mcpTools'), empty: 'resources.noMcpToolsDeclared', icon: Wrench },
    sandboxes: {
      title: t('resources.sandboxes'),
      empty: 'resources.noSandboxesDeclared',
      icon: Box,
    },
    secrets: {
      title: t('resources.secretReferences'),
      empty: 'resources.noSecretReferencesDeclared',
      icon: KeyRound,
    },
  } satisfies Record<typeof tab, { title: string; empty: MessageKey; icon: typeof Bot }>;
  const resources = Object.entries(pipeline?.spec[tab] ?? {});
  const Icon = meta[tab].icon;
  return (
    <section className="page pb-8.75 min-h-full">
      <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <div className="breadcrumb text-[10px] text-muted flex items-center gap-2.25 mb-3">
            {t('resources.workspace')}
            <ChevronRight size={13} />
            {t('navigation.resources')}
          </div>
          <h1>{t('resources.modelsTools')}</h1>
          <p>
            {t('resources.logicalResourcesDeclaredByName', {
              name:
                pipeline?.metadata.title ??
                pipeline?.metadata.name ??
                t('resources.yourSelectedPipeline'),
            })}
          </p>
        </div>
        <button type="button" className="button" onClick={() => onSource(tab)}>
          {t('resources.editPipelineResources')}
          <ArrowUpRight size={15} />
        </button>
      </header>
      <div className="notice flex items-start gap-3 border border-solid border-line-strong rounded-[16px] bg-[rgb(var(--accent-rgb)_/_0.027)] text-accent mb-6.25 px-5 py-4.5">
        <ShieldCheck size={18} />
        <div>
          <strong>{t('resources.resolvedByYourEngineProfile')}</strong>
          <p>{t('resources.aPipelineDeclaresAliasesTheTrustedEngineSupplies')}</p>
        </div>
      </div>
      {engine.info ? (
        <div className="settings-card max-w-250 border border-solid border-line rounded-[20px] bg-surface mb-6 p-7.5">
          <h2>{t('resources.engineResourceCatalog')}</h2>
          <p className="small muted text-[11px] text-muted">
            {t('resources.connectionsConfiguredInTheEngineProfilesAvailabilityReflects')}
          </p>
          <div className="engine-resource-list grid grid-cols-[repeat(auto-fit,_minmax(180px,_1fr))] gap-4 mt-4">
            {engine.resources.map((resource) => (
              <div key={JSON.stringify([resource.kind, resource.title, resource.id])}>
                <strong>{resource.title}</strong>
                <code>{resource.id}</code>
                <span>
                  {resource.kind} · {resource.status}
                </span>
                <small>{resource.capabilities.join(', ')}</small>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="underline-tabs resource-tabs flex border-b border-solid border-b-line gap-6.25 shrink-0 mb-6.25 p-0">
        {Object.entries(meta).map(([key, m]) => (
          <button
            type="button"
            key={key}
            onClick={() => setTab(key as typeof tab)}
            className={key === tab ? 'active' : ''}
          >
            <m.icon size={16} />
            {m.title}
            <span className="counter text-[9px] bg-surface-active rounded-[3px] text-secondary px-1 py-px">
              {Object.keys(pipeline?.spec[key as typeof tab] ?? {}).length}
            </span>
          </button>
        ))}
      </div>
      {resources.length ? (
        <div className="resource-grid grid grid-cols-[repeat(auto-fill,_minmax(240px,_1fr))] gap-4.75">
          {resources.map(([id, resource]) => (
            <article
              className="resource-card border border-solid border-line rounded-[20px] bg-surface p-6.25"
              key={id}
            >
              <div className="inline-row spread flex items-center gap-2.5 justify-between">
                <span className="resource-icon grid place-items-center w-11 h-11 rounded-[12px] bg-[rgb(var(--accent-rgb)_/_0.094)] border border-solid border-[rgb(var(--accent-rgb)_/_0.188)] text-secondary">
                  <Icon size={22} />
                </span>
                <span className="type-label inline-flex text-[10px] text-secondary bg-[rgb(var(--overlay-rgb)_/_0.016)] border border-solid border-line-strong rounded-[30px] px-2 py-1.25">
                  {t('resources.declared')}
                </span>
              </div>
              <h2>{id}</h2>
              <div className="detail-field flex flex-col gap-2.25 mb-5.75">
                <span>
                  {t(
                    tab === 'sandboxes'
                      ? 'resources.profile'
                      : tab === 'secrets'
                        ? 'resources.secretReference'
                        : 'resources.connection',
                  )}
                </span>
                <code>
                  {String(
                    record(resource).connection ?? record(resource).profile ?? record(resource).ref,
                  )}
                </code>
              </div>
              {Array.isArray(record(resource).requires) ? (
                <div className="capability-list flex gap-1.5 flex-wrap">
                  {(record(resource).requires as string[]).map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                </div>
              ) : null}
              <footer>
                <span className="dot amber inline-block w-1.5 h-1.5 bg-surface-raised rounded-full shrink-0" />
                {t('resources.checkedDuringRunAdmission')}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty icon={<Icon size={30} />} title={t(meta[tab].empty)}>
          {t('resources.addResourceAliasesInThePipelineYamlWhen')}
        </Empty>
      )}
    </section>
  );
}

export function SettingsView({
  engine,
  engineUrl,
  desktop,
  theme,
  onTheme,
  language,
  onLanguage,
  onSaveUrl,
  onBackup,
  onRestore,
  onNotify,
}: {
  engine: EngineController;
  engineUrl: string;
  desktop: boolean;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  language: Locale;
  onLanguage: (locale: Locale) => void;
  onSaveUrl: (url: string) => void;
  onBackup: () => void;
  onRestore: () => void;
  onNotify: (message: string) => void;
}) {
  const { t, message } = useI18n();
  const [url, setUrl] = useState(engineUrl);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  function save() {
    try {
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error('Use an HTTP(S) base URL without credentials, query or fragment.');
      onSaveUrl(parsed.toString().replace(/\/$/, ''));
      setError('');
      onNotify('resources.engineAddressSavedConnectToCheckItsProtocol');
    } catch (e) {
      setError(
        e instanceof TypeError || !(e instanceof Error)
          ? 'resources.enterAValidEngineUrl'
          : e.message,
      );
    }
  }
  return (
    <section className="page settings-page pb-8.75 min-h-full">
      <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <div className="breadcrumb text-[10px] text-muted flex items-center gap-2.25 mb-3">
            {t('resources.workspace')}
            <ChevronRight size={13} />
            {t('resources.preferences')}
          </div>
          <h1>{t('resources.workspaceSettings')}</h1>
          <p>{t('resources.aLocalDesktopClientForProcessesUnderYour')}</p>
        </div>
        <span className="type-label inline-flex text-[10px] text-secondary bg-[rgb(var(--overlay-rgb)_/_0.016)] border border-solid border-line-strong rounded-[30px] px-2 py-1.25">
          v0.1.0
        </span>
      </header>
      <div className="settings-card max-w-250 border border-solid border-line rounded-[20px] bg-surface mb-6 p-7.5">
        <div className="settings-section-heading flex items-center gap-3.75 text-muted mb-6.5">
          <Sun size={21} />
          <div>
            <h2>{t('settings.appearance')}</h2>
            <p>{t('resources.chooseThePaletteForYourWorkspaceAndEditor')}</p>
          </div>
        </div>
        <div
          className="theme-options flex gap-4 mt-5"
          role="radiogroup"
          aria-label={t('resources.colorTheme')}
        >
          {(['dark', 'light'] as const).map((option) => (
            // biome-ignore lint/a11y/useSemanticElements: Palette tiles implement the radio keyboard pattern and present an interactive theme preview.
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={theme === option}
              tabIndex={theme === option ? 0 : -1}
              onKeyDown={(event) => {
                if (
                  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                    event.key,
                  )
                ) {
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'dark'
                      : event.key === 'End'
                        ? 'light'
                        : option === 'dark'
                          ? 'light'
                          : 'dark';
                  onTheme(next);
                  (
                    event.currentTarget.parentElement?.querySelector(
                      `[aria-label="${t(next === 'dark' ? 'resources.dark' : 'resources.light')}"]`,
                    ) as HTMLButtonElement
                  )?.focus();
                }
              }}
              aria-label={t(option === 'dark' ? 'resources.dark' : 'resources.light')}
              className={`theme-option w-45 flex flex-col gap-3 text-left border border-solid border-line rounded-[12px] text-secondary p-3 ${theme === option ? 'selected' : ''}`}
              onClick={() => onTheme(option)}
            >
              <span
                className={`theme-preview flex h-21 rounded-[6px] overflow-hidden border border-solid border-line theme-preview-${option}`}
                aria-hidden="true"
              >
                <i />
                <span>
                  <b />
                  <b />
                  <b />
                </span>
              </span>
              <span className="inline-row spread flex items-center gap-2.5 justify-between">
                <span className="inline-row flex items-center gap-2.5">
                  {option === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
                  {t(option === 'dark' ? 'resources.dark' : 'resources.light')}
                </span>
                {theme === option ? <Check size={15} /> : null}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="settings-card max-w-250 border border-solid border-line rounded-[20px] bg-surface mb-6 p-7.5">
        <div className="settings-section-heading flex items-center gap-3.75 text-muted mb-6.5">
          <Globe size={21} />
          <div>
            <h2>{t('settings.language')}</h2>
            <p>{t('resources.chooseTheLanguageForTheInterface')}</p>
          </div>
        </div>
        <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
          {t('settings.language')}
          <select
            aria-label={t('settings.language')}
            value={language}
            onChange={(event) => onLanguage(event.target.value as Locale)}
          >
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <div className="settings-card max-w-250 border border-solid border-line rounded-[20px] bg-surface mb-6 p-7.5">
        <div className="settings-section-heading flex items-center gap-3.75 text-muted mb-6.5">
          <Globe size={21} />
          <div>
            <h2>{t('resources.engine')}</h2>
            <p>{t('resources.connectToYourKnotraEngineToRunWorkflows')}</p>
          </div>
          <span className={`status status-${engine.info ? 'succeeded' : 'pending'}`}>
            <span />
            {t(
              engine.info
                ? engine.error
                  ? 'resources.unavailable'
                  : 'resources.connected'
                : 'resources.disconnected',
            )}
          </span>
        </div>
        <p className="muted text-muted">{t('resources.quickstartHint')}</p>
        <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
          {t('resources.engineBaseUrl')}
          <div className="inline-row flex items-center gap-2.5">
            <input
              aria-label={t('resources.engineBaseUrl')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="button" className="button" onClick={save}>
              {t('resources.saveAddress')}
            </button>
          </div>
        </label>
        {error ? (
          <p
            className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
            role="alert"
          >
            {message(error)}
          </p>
        ) : null}
        <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
          {t('resources.accessTokenOptionalForLoopback')}
          <input
            type="password"
            aria-label={t('resources.engineAccessToken')}
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <div className="inline-row flex items-center gap-2.5">
          <button
            type="button"
            className="button primary"
            disabled={engine.connecting}
            onClick={() => {
              void engine.connect(url, token || undefined);
              setToken('');
            }}
          >
            {t(engine.connecting ? 'resources.connecting' : 'resources.connectEngine')}
          </button>
          {engine.info ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                void engine.disconnect().catch((error) => onNotify(String(error)));
              }}
            >
              {t('resources.disconnect')}
            </button>
          ) : null}
        </div>
        {engine.error ? (
          <p
            className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
            role="alert"
          >
            {t('resources.connectionError')}: {engine.error}
          </p>
        ) : null}
        {engine.info ? (
          <div className="detail-field flex flex-col gap-2.25 mb-5.75">
            <span>{t('resources.engineIdentityProtocol')}</span>
            <code>
              {engine.info.engineId} · {engine.info.protocol}
            </code>
            <small>
              {t('resources.profilesProfilesResourcesResources', {
                profiles: engine.profiles.length,
                resources: engine.resources.length,
              })}
            </small>
          </div>
        ) : null}
        <div className="notice small text-[11px] flex items-start gap-3 border border-solid border-line-strong rounded-[16px] bg-[rgb(var(--accent-rgb)_/_0.027)] text-accent mb-6.25 px-5 py-4.5">
          {t('resources.startYourLocalKnotraEngineAndConnectUsing')}
        </div>
      </div>
      <div className="settings-card max-w-250 border border-solid border-line rounded-[20px] bg-surface mb-6 p-7.5">
        <div className="settings-section-heading flex items-center gap-3.75 text-muted mb-6.5">
          <Monitor size={21} />
          <div>
            <h2>{t('resources.workspace')}</h2>
            <p>{t('resources.pipelineDraftsSettingsAndDemoHistoryStayOn')}</p>
          </div>
        </div>
        <div className="setting-row flex items-center justify-between gap-6.25 border-t border-solid border-t-line px-0 py-5">
          <div>
            <strong>{t('resources.backUpYourWorkspace')}</strong>
            <p>{t('resources.downloadDraftsSupportingFilesAndDemoRunHistory')}</p>
          </div>
          <button type="button" className="button" onClick={onBackup}>
            {t('resources.exportBackup')}
          </button>
        </div>
        <div className="setting-row flex items-center justify-between gap-6.25 border-t border-solid border-t-line px-0 py-5">
          <div>
            <strong>{t('resources.restoreAWorkspaceBackup')}</strong>
            <p>{t('resources.reviewAJsonBackupBeforeReplacingLocalDrafts')}</p>
          </div>
          <button type="button" className="button" onClick={onRestore}>
            {t('resources.chooseBackup')}
          </button>
        </div>
        <div className="setting-row flex items-center justify-between gap-6.25 border-t border-solid border-t-line px-0 py-5">
          <div>
            <strong>{t('resources.applicationRuntime')}</strong>
            <p>
              {t(
                desktop
                  ? 'resources.tauriDesktopNativePackageDialogs'
                  : 'resources.browserPreviewYamlAndZipImportExport',
              )}
            </p>
          </div>
          <span className="type-label inline-flex text-[10px] text-secondary bg-[rgb(var(--overlay-rgb)_/_0.016)] border border-solid border-line-strong rounded-[30px] px-2 py-1.25">
            {t(desktop ? 'resources.desktop' : 'resources.preview')}
          </span>
        </div>
      </div>
      <div className="about-card flex items-center gap-3.75 max-w-212.5 px-0 py-4">
        <img src="/knotra.svg" alt="" />
        <div>
          <h2>Knotra</h2>
          <p>{t('resources.makeTheProcessExplicit')}</p>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            void openProjectDocs().catch((error) => onNotify(String(error)));
          }}
        >
          {t('resources.projectDocumentation')}
          <ExternalLink size={14} />
        </button>
      </div>
    </section>
  );
}
