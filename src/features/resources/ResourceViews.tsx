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
  Sun,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { engineEndpoint } from '../../lib/engine/client';
import type { EngineController } from '../../lib/engine/useEngine';
import { type Locale, type MessageKey, useI18n } from '../../lib/i18n';
import { openProjectDocs } from '../../lib/native';
import type { SavedConnection, SavedMcpConnection } from '../../lib/setup';
import type { Theme } from '../../lib/theme';
import type { Pipeline } from '../../lib/types';
import { DataBlock } from '../engine/execution/DataBlock';
import DesktopControlSetup from './DesktopControlSetup';
import { EngineConnections } from './EngineConnections';
import EngineSetup from './EngineSetup';
import McpSetup from './McpSetup';
import ModelSetup from './ModelSetup';
import ResourceAssignments, { type ResourceKind } from './ResourceAssignments';

export function ConnectionsView({
  tour,
  pipeline,
  onSource,
  onEditNode,
  onManage,
  engine,
  modelConnections = [],
  mcpConnections = [],
}: {
  tour?: ReactNode;
  engine: EngineController;
  modelConnections?: SavedConnection[];
  mcpConnections?: SavedMcpConnection[];
  pipeline?: Pipeline;
  onSource: (kind: ResourceKind) => void;
  onEditNode: (path: string[], kind: ResourceKind) => void;
  onManage: (kind: ResourceKind) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<ResourceKind>('models');
  const meta = {
    models: { title: 'resources.models', icon: Bot, manage: 'editor.connectModelSources' },
    mcp: { title: 'resources.mcpTools', icon: Wrench, manage: 'editor.connectMcp' },
    sandboxes: { title: 'resources.sandboxes', icon: Box, manage: 'editor.manageSandboxes' },
    secrets: {
      title: 'resources.secretReferences',
      icon: KeyRound,
      manage: 'resources.manageEngine',
    },
  } satisfies Record<ResourceKind, { title: MessageKey; icon: typeof Bot; manage: MessageKey }>;

  return (
    <section className="page pb-8.75 min-h-full">
      <header className="page-heading flex flex-wrap items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <div className="breadcrumb text-[10px] text-muted flex items-center gap-2.25 mb-3">
            {t('resources.workspace')}
            <ChevronRight size={13} />
            {t('navigation.resources')}
          </div>
          <h1>{t('resources.modelsTools')}</h1>
          <p>
            {t('resources.connectionsForPipeline', {
              name:
                pipeline?.metadata.title ??
                pipeline?.metadata.name ??
                t('resources.yourSelectedPipeline'),
            })}
          </p>
        </div>
        <button type="button" className="button" onClick={() => onManage(tab)}>
          {t(meta[tab].manage)} <ArrowUpRight size={15} />
        </button>
      </header>
      {tour}
      <div className="underline-tabs resource-tabs flex flex-wrap border-b border-solid border-b-line gap-x-6.25 gap-y-2 shrink-0 mb-6.25 p-0">
        {(Object.keys(meta) as ResourceKind[]).map((key) => {
          const Icon = meta[key].icon;
          return (
            <button
              type="button"
              key={key}
              onClick={() => setTab(key)}
              className={key === tab ? 'active' : ''}
            >
              <Icon size={16} /> {t(meta[key].title)}
            </button>
          );
        })}
      </div>
      {pipeline ? (
        <ResourceAssignments
          pipeline={pipeline}
          kind={tab}
          models={modelConnections}
          mcp={mcpConnections}
          engineResources={engine.info && !engine.error ? engine.resources : []}
          engineConnected={!!engine.info && !engine.error}
          onEdit={(path) => onEditNode(path, tab)}
        />
      ) : (
        <p className="mx-7.5 mb-8 text-[13px] text-secondary">{t('resources.selectPipeline')}</p>
      )}
      {pipeline ? (
        <details className="resource-bindings mx-7.5 my-6 border-t border-solid border-line pt-4">
          <summary className="cursor-pointer text-[12px] text-secondary">
            {t('resources.advancedBindings')}
          </summary>
          <p className="my-3 max-w-180 text-[12px] leading-5 text-muted">
            {t('resources.aliasExplanation')}
          </p>
          <DataBlock label={t('resources.bindingDetails')} value={pipeline.spec[tab] ?? {}} open />
          <button type="button" className="text-button my-3" onClick={() => onSource(tab)}>
            {t('resources.editPipelineResources')} <ArrowUpRight size={14} />
          </button>
        </details>
      ) : null}
      {engine.info ? (
        <details className="mx-7.5 my-6 border-t border-solid border-line pt-4">
          <summary className="cursor-pointer text-[12px] text-secondary">
            {t('resources.availableEngineConnections')}
          </summary>
          <div className="mt-4">
            <EngineConnections
              resources={engine.resources}
              profiles={engine.profiles}
              sources={modelConnections}
              mcpSources={mcpConnections}
            />
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function SettingsView({
  tour,
  engine,
  engineUrl,
  engineMode,
  desktop,
  theme,
  onTheme,
  language,
  onLanguage,
  onBackup,
  onRestore,
  onStartTour,
  onNotify,
  onSetupReady,
  onSetupStopped,
  onManualEngineAction,
}: {
  tour?: ReactNode;
  engine: EngineController;
  engineUrl: string;
  engineMode?: 'local' | 'manual';
  desktop: boolean;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  language: Locale;
  onLanguage: (locale: Locale) => void;
  onBackup: () => void;
  onRestore: () => void;
  onStartTour: () => void;
  onNotify: (message: string) => void;
  onSetupReady: (endpoint: string) => Promise<void>;
  onSetupStopped: (endpoint: string | undefined) => Promise<void>;
  onManualEngineAction?: (endpoint?: string) => void;
}) {
  const { t, message } = useI18n();
  const [url, setUrl] = useState(engineUrl);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [manualOpen, setManualOpen] = useState(!desktop || engineMode === 'manual');
  const manualConnected = !!engine.info && (!desktop || engineMode === 'manual');
  const manualError = !desktop || engineMode === 'manual' ? engine.error : '';
  const connectionHelp = useId();

  useEffect(() => setUrl(engineUrl), [engineUrl]);

  async function connect() {
    const accessToken = token || undefined;
    setToken('');
    let endpoint: string;

    try {
      endpoint = engineEndpoint(url.trim(), accessToken);
      setError('');
    } catch (e) {
      setError(
        e instanceof TypeError || !(e instanceof Error)
          ? 'resources.enterAValidEngineUrl'
          : e.message,
      );
      return;
    }
    onManualEngineAction?.();
    const connected = await engine.connect(endpoint, accessToken);
    if (connected) {
      setUrl(endpoint);
      onManualEngineAction?.(endpoint);
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
      {tour}
      <ModelSetup />
      <McpSetup />
      <EngineSetup
        onReady={onSetupReady}
        onStopped={onSetupStopped}
        connectedUrl={engine.info ? engineUrl : undefined}
      />
      <DesktopControlSetup />
      <details
        data-tour="engine"
        open={manualOpen}
        onToggle={(event) => setManualOpen(event.currentTarget.open)}
        className="settings-card existing-engine max-w-250 border border-solid border-line rounded-[20px] bg-surface mb-6 p-7.5"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-3 text-[18px] font-medium text-secondary">
            <Globe size={20} />
            {t('resources.existingEngine')}
          </span>
          <ChevronRight
            size={18}
            className={`shrink-0 text-muted transition-transform duration-150 ${manualOpen ? 'rotate-90' : ''}`}
          />
        </summary>
        <p id={connectionHelp} className="mt-3 max-w-[65ch] text-[12px] leading-relaxed text-muted">
          {t('resources.existingEngineHelp')}
        </p>
        <form
          className="mt-6"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <label className="field flex flex-col gap-2 text-[12px] text-secondary mb-5">
            {t('resources.engineBaseUrl')}
            <input
              className="w-full min-w-0"
              aria-label={t('resources.engineBaseUrl')}
              aria-describedby={connectionHelp}
              placeholder="https://engine.example.com"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={engine.connecting}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="field flex flex-col gap-2 text-[12px] text-secondary mb-5">
            {t('resources.engineAccessToken')}
            <input
              className="w-full min-w-0"
              type="password"
              aria-label={t('resources.engineAccessToken')}
              aria-describedby={`${connectionHelp}-token`}
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={engine.connecting}
            />
            <small id={`${connectionHelp}-token`} className="text-muted">
              {t('resources.existingEngineTokenHelp')}
            </small>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="button primary" disabled={engine.connecting}>
              {t(engine.connecting ? 'resources.connecting' : 'resources.connectEngine')}
            </button>
            {manualConnected ? (
              <button
                type="button"
                className="button"
                onClick={() => {
                  onManualEngineAction?.();
                  void engine.disconnect().catch((error) => onNotify(String(error)));
                }}
              >
                {t('resources.disconnect')}
              </button>
            ) : null}
          </div>
        </form>
        {error || manualError ? (
          <p
            className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
            role="alert"
          >
            {error ? message(error) : `${t('resources.connectionError')}: ${manualError}`}
          </p>
        ) : null}
        {manualConnected && engine.info ? (
          <div className="mt-6 border-t border-solid border-line pt-4 text-[12px]">
            <div className="flex flex-wrap items-center justify-between gap-2 text-secondary">
              <span>{t(engine.error ? 'resources.unavailable' : 'resources.connected')}</span>
              <span>{engine.info.protocol}</span>
            </div>
            <p className="mt-2 break-all text-muted">{engineUrl}</p>
            <code className="mt-1 block break-all text-muted">{engine.info.engineId}</code>
            <small className="mt-2 block text-muted">
              {t('resources.profilesProfilesResourcesResources', {
                profiles: engine.profiles.length,
                resources: engine.resources.length,
              })}
            </small>
          </div>
        ) : null}
      </details>
      <div className="settings-card max-w-250 border border-solid border-line rounded-[20px] bg-surface mb-6 p-7.5">
        <div className="settings-section-heading flex items-center justify-between flex-wrap gap-4">
          <div className="min-w-60">
            <h2>{t('tour.settings.title')}</h2>
            <p>{t('tour.settings.description')}</p>
          </div>
          <button type="button" className="button shrink-0" onClick={onStartTour}>
            {t('tour.settings.start')}
          </button>
        </div>
      </div>
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
      </div>
      <footer className="about-card flex flex-wrap items-center justify-between gap-x-6 gap-y-3 max-w-250 px-7.5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/knotra.svg" alt="" className="size-8 shrink-0" />
          <div>
            <h2 className="text-[15px] font-medium leading-tight tracking-tight text-secondary">
              Knotra
            </h2>
            <p className="mt-1 text-[11px] text-muted">{t('resources.makeTheProcessExplicit')}</p>
          </div>
        </div>
        <button
          type="button"
          className="text-button inline-flex min-h-11 shrink-0 items-center gap-2 text-[11px] text-muted"
          onClick={() => {
            void openProjectDocs().catch((error) => onNotify(String(error)));
          }}
        >
          {t('resources.projectDocumentation')}
          <ExternalLink size={14} />
        </button>
      </footer>
    </section>
  );
}
