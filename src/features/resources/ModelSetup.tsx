import {
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { desktop } from '../../lib/native';
import {
  cancelProviderSignIn,
  openDependency,
  type ProviderModel,
  providerModels,
  refreshConnection,
  removeConnection,
  type SavedConnection,
  type SetupProvider,
  type SetupStatus,
  saveConnection,
  savedConnections,
  setupStatus,
  signInProvider,
} from '../../lib/setup';

type Provider = '' | SetupProvider;
type Action = 'sign-in' | 'save' | 'models' | 'sources';

function errorText(error: unknown, apiKey: string): string {
  const text = error instanceof Error ? error.message : String(error);
  const secret = apiKey.trim();

  return secret ? text.replaceAll(secret, '…') : text;
}

export default function ModelSetup() {
  const { t } = useI18n();
  const hintId = useId();
  const [sources, setSources] = useState<SavedConnection[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(desktop);
  const [editing, setEditing] = useState<SavedConnection>();
  const [title, setTitle] = useState('');
  const [formOpen, setFormOpen] = useState(true);
  const [provider, setProvider] = useState<Provider>('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [accountSelected, setAccountSelected] = useState(false);
  const [status, setStatus] = useState<SetupStatus>();
  const [action, setAction] = useState<Action>();
  const [canceling, setCanceling] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [catalogEmpty, setCatalogEmpty] = useState(false);
  const revision = useRef(0);
  const statusRevision = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const chooserRef = useRef<HTMLHeadingElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const requestedFocus = useRef<'name' | 'chooser' | 'add' | undefined>(undefined);

  const account = provider === 'codex' || provider === 'claude';
  const selected = provider || undefined;
  const compatible = provider === 'openai-compatible';
  const hasAuth = !!provider;
  const needsKey = hasAuth && !account && provider !== 'ollama';
  let endpoint = compatible ? '' : (editing?.baseUrl ?? '');
  if (compatible) {
    try {
      const url = new URL(baseUrl.trim());
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        endpoint = url.href.replace(/\/+$/, '');
    } catch {
      /* Keep the address editable until it is complete. */
    }
  }

  const credentialsReady =
    hasAuth &&
    (!compatible || !!endpoint) &&
    (!needsKey || compatible || !!apiKey.trim() || !!editing?.hasCredential);
  const validModel = !model.trim() || /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(model.trim());
  const canSave = desktop && credentialsReady && validModel && (!account || accountSelected);
  const canLoadModels =
    credentialsReady &&
    (!needsKey ||
      compatible ||
      !!apiKey.trim() ||
      (!!editing && endpoint === (editing.baseUrl ?? '')));
  const busy = !!action || canceling || sourcesLoading;
  const credentials = {
    ...(needsKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(endpoint ? { baseUrl: endpoint } : {}),
  };
  const choices = [
    { id: 'codex', title: 'Codex', description: t('modelSetup.chatgptAccount') },
    { id: 'claude', title: 'Claude Code', description: t('modelSetup.claudeAccount') },
    { id: 'openai', title: 'OpenAI API', description: t('modelSetup.apiKey') },
    { id: 'anthropic', title: 'Anthropic API', description: t('modelSetup.apiKey') },
    {
      id: 'openai-compatible',
      title: t('modelSetup.compatibleShort'),
      description: t('modelSetup.customEndpoint'),
    },
    { id: 'ollama', title: 'Ollama', description: t('modelSetup.localModels') },
  ] satisfies { id: SetupProvider; title: string; description: string }[];
  const providerLabel = (id: string) =>
    choices.find((choice) => choice.id === id.replace('_', '-'))?.title ?? id;

  useEffect(() => {
    const target = requestedFocus.current;
    requestedFocus.current = undefined;
    if (target === 'name') nameRef.current?.focus();
    else if (target === 'chooser') chooserRef.current?.focus();
    else if (target === 'add') addRef.current?.focus();
  });

  const receive = useCallback(
    (next: SetupStatus, current: number) => {
      if (current !== revision.current) return;
      statusRevision.current++;
      setStatus(next);
      if ((next.sourcePhase ?? next.phase) === 'signing_in') return;
      if ((next.sourcePhase ?? next.phase) === 'error')
        setError(
          errorText(
            next.sourceError ||
              next.sourceMessage ||
              next.error ||
              next.message ||
              t('modelSetup.failed'),
            apiKey,
          ),
        );
      else setAccountSelected(true);
      setAction(undefined);
    },
    [apiKey, t],
  );

  function changed() {
    window.dispatchEvent(new Event('knotra-connections-changed'));
  }

  useEffect(() => {
    if (!desktop) return;

    const current = ++revision.current;
    let active = true;
    let inventoryRevision = 0;
    // Runtime probes can be slow; load the saved inventory independently.
    function loadInventory(initial = false) {
      const request = ++inventoryRevision;
      return savedConnections()
        .then((items) => {
          if (!active || request !== inventoryRevision) return;
          setSources(items);
          if (initial) setFormOpen(!items.length);
        })
        .catch((error) => {
          if (active && request === inventoryRevision) setError(errorText(error, ''));
        })
        .finally(() => {
          if (active && request === inventoryRevision) setSourcesLoading(false);
        });
    }
    const inventory = loadInventory(true);
    const refreshInventory = () => {
      void loadInventory();
      const request = ++statusRevision.current;
      void setupStatus()
        .then((next) => {
          if (active && request === statusRevision.current) setStatus(next);
        })
        .catch(() => {});
    };
    window.addEventListener('knotra-connections-changed', refreshInventory);
    const request = ++statusRevision.current;
    void setupStatus()
      .then(async (next) => {
        await inventory;
        if (!active || current !== revision.current || request !== statusRevision.current) return;
        setStatus(next);
        if ((next.sourcePhase ?? next.phase) === 'signing_in') {
          setFormOpen(true);
          setAction('sign-in');
          setProvider(next.sourceProvider === 'claude' ? 'claude' : 'codex');
        }
        if (next.sourceError) setError(next.sourceError);
      })
      .catch(() => {});
    return () => {
      active = false;
      revision.current++;
      statusRevision.current++;
      window.removeEventListener('knotra-connections-changed', refreshInventory);
    };
  }, []);

  useEffect(() => {
    if ((status?.sourcePhase ?? status?.phase) !== 'signing_in') return;

    const current = revision.current;
    let active = true;
    const timer = window.setTimeout(() => {
      const request = ++statusRevision.current;
      void setupStatus()
        .then((next) => {
          if (!active || request !== statusRevision.current) return;
          if (action === 'sign-in') receive(next, current);
          else setStatus(next);
        })
        .catch((error) => {
          if (!active || request !== statusRevision.current) return;
          if (action === 'sign-in' && current === revision.current) {
            setError(errorText(error, apiKey));
            setAction(undefined);
          }
          setStatus((previous) => (previous ? { ...previous } : previous));
        });
    }, 1000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [action, apiKey, receive, status]);

  function reset() {
    revision.current++;
    setAction(undefined);
    setModels([]);
    setModel('');
    setCatalogFailed(false);
    setAccountSelected(false);
    setSaved(false);
    setError('');
    setCatalogEmpty(false);
  }

  async function signIn() {
    if (selected !== 'codex' && selected !== 'claude') return;

    const current = ++revision.current;
    setAction('sign-in');
    setError('');
    setAccountSelected(false);

    try {
      receive(await signInProvider(selected), current);
    } catch (error) {
      if (current === revision.current) {
        setError(errorText(error, apiKey));
        setAction(undefined);
      }
    }
  }

  async function loadModels() {
    if (!selected || !credentialsReady) return;

    const current = ++revision.current;
    setAction('models');
    setModels([]);
    setError('');
    setCatalogEmpty(false);
    setCatalogFailed(false);

    try {
      const stored =
        editing && !apiKey.trim() && endpoint === (editing.baseUrl ?? '')
          ? await refreshConnection(editing.id, editing.revision)
          : undefined;
      const items =
        stored?.models ?? (await providerModels({ provider: selected, ...credentials }));
      if (stored) {
        setSources((items) => items.map((item) => (item.id === stored.id ? stored : item)));
        changed();
      }
      if (current !== revision.current) return;
      if (stored) setEditing(stored);
      setModels(items);
      setModel('');
      setCatalogEmpty(!items.length);
    } catch (error) {
      if (current === revision.current) {
        setError(errorText(error, apiKey));
        setCatalogFailed(true);
      }
    } finally {
      if (current === revision.current) setAction(undefined);
    }
  }

  async function save() {
    if (!selected || !canSave) return;

    const current = ++revision.current;
    setAction('save');
    setError('');

    try {
      const item = await saveConnection({
        ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        provider: selected,
        ...credentials,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      changed();
      if (current !== revision.current) return;
      setSources((items) => [...items.filter((source) => source.id !== item.id), item]);
      setApiKey('');
      setSaved(true);
      requestedFocus.current = 'add';
      setFormOpen(false);
      setEditing(undefined);
    } catch (error) {
      if (current === revision.current) {
        setError(errorText(error, apiKey));
        setCatalogFailed(true);
      }
    } finally {
      if (current === revision.current) setAction(undefined);
    }
  }

  async function cancel() {
    const current = ++revision.current;
    setCanceling(true);

    try {
      const next = await cancelProviderSignIn();
      if (current === revision.current) {
        setStatus(next);
        setError('');
      }
    } catch (error) {
      if (current === revision.current) setError(errorText(error, apiKey));
    } finally {
      if (current === revision.current) {
        setAction(undefined);
        setCanceling(false);
      }
    }
  }

  function edit(source?: SavedConnection) {
    reset();
    setEditing(source);
    setTitle(source?.title ?? '');
    setProvider((source?.provider?.replace('_', '-') ?? '') as Provider);
    setApiKey('');
    setBaseUrl(source?.baseUrl ?? '');
    setModels(source?.models ?? []);
    setModel('');
    setAccountSelected(source?.provider === 'codex' || source?.provider === 'claude');
    setFormOpen(true);
    requestedFocus.current = source ? 'name' : 'chooser';
  }

  function choose(next: SetupProvider) {
    reset();
    setProvider(next);
    setTitle('');
    setApiKey('');
    setBaseUrl('');
    requestedFocus.current = 'name';
  }

  async function update(source: SavedConnection, remove: boolean) {
    const current = ++revision.current;
    setAction('sources');
    setError('');

    try {
      if (remove) {
        const items = await removeConnection(source.id, source.revision);
        changed();
        if (current !== revision.current) return;
        setSources(items);
        if (editing?.id === source.id || !items.length) edit();
      } else {
        const item = await refreshConnection(source.id, source.revision);
        changed();
        if (current !== revision.current) return;
        setSources((items) => items.map((source) => (source.id === item.id ? item : source)));
        if (editing?.id === item.id && editing.revision === source.revision) {
          setModels(item.models);
          setEditing(item);
        }
      }
    } catch (error) {
      if (current === revision.current) setError(errorText(error, apiKey));
    } finally {
      if (current === revision.current) setAction(undefined);
    }
  }

  async function open(dependency: 'docker' | 'ollama') {
    const current = revision.current;

    try {
      await openDependency(dependency);
      const next = await setupStatus();
      if (current === revision.current) setStatus(next);
    } catch (error) {
      if (current === revision.current) setError(errorText(error, apiKey));
    }
  }

  return (
    <section className="settings-card model-setup @container max-w-250 overflow-hidden rounded-[12px] border border-solid border-line bg-surface mb-6">
      <header className="flex items-start justify-between gap-4 px-6 py-5">
        <div className="min-w-0">
          <h2 className="text-[18px] font-medium tracking-tight">{t('modelSetup.title')}</h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{t('modelSetup.intro')}</p>
        </div>
        {sources.length ? (
          <button
            ref={addRef}
            type="button"
            className="button shrink-0"
            disabled={busy || formOpen}
            onClick={() => edit()}
          >
            <Plus size={14} />
            {t('modelSetup.addSource')}
          </button>
        ) : null}
      </header>

      {sources.length ? (
        <ul aria-label={t('modelSetup.savedSources')} className="m-0 list-none p-0">
          {sources.map((source) => {
            const Icon =
              source.provider === 'codex' || source.provider === 'claude'
                ? Terminal
                : source.provider === 'ollama'
                  ? Server
                  : KeyRound;
            return (
              <li
                key={source.id}
                className={[
                  'group flex items-center gap-3 border-t border-solid border-line px-6 py-3.5',
                  editing?.id === source.id && formOpen ? 'bg-surface-highlight' : '',
                ].join(' ')}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                  disabled={busy}
                  onClick={() => edit(source)}
                  aria-label={t('modelSetup.editSource', { name: source.title })}
                >
                  <Icon size={18} className="shrink-0 text-muted" />
                  <span className="min-w-0">
                    <strong className="block break-words text-[13px] font-medium text-secondary">
                      {source.title}
                    </strong>
                    <span className="mt-0.5 block break-words text-[11px] leading-relaxed text-muted">
                      {providerLabel(source.provider)} ·{' '}
                      {t('modelSetup.availableModels', { count: source.models.length })}
                      {source.baseUrl ? (
                        <span className="block break-all">
                          {source.baseUrl.replace(/^https?:\/\//, '')}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    onClick={() => void update(source, false)}
                    aria-label={t('modelSetup.refreshSource', { name: source.title })}
                    title={t('modelSetup.refresh')}
                  >
                    <RefreshCw size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    onClick={() => void update(source, true)}
                    aria-label={t('modelSetup.removeSource', { name: source.title })}
                    title={t('modelSetup.remove')}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {!desktop ? (
        <p
          role="status"
          className="border-t border-solid border-line px-6 py-4 text-[12px] leading-relaxed text-muted"
        >
          {t('modelSetup.browserOnly')}
        </p>
      ) : null}
      {action === 'sources' ? (
        <p role="status" className="px-6 py-3 text-[11px] text-muted">
          {t('modelSetup.updatingSources')}
        </p>
      ) : null}

      {sourcesLoading ? (
        <p role="status" className="px-6 pb-5 text-[12px] text-muted">
          {t('modelSetup.loadingSources')}
        </p>
      ) : null}
      {action !== 'sign-in' && status?.sourcePhase === 'signing_in' ? (
        <div
          role="status"
          className="external-provider-login border-t border-solid border-line px-6 py-4 text-[12px] text-secondary"
        >
          <strong>{providerLabel(status.sourceProvider ?? 'codex')}</strong>
          <p className="mt-1">{t('modelSetup.signingIn')}</p>
          {status.sourceMessage ? (
            <p className="mt-2 text-[11px] text-muted">{errorText(status.sourceMessage, apiKey)}</p>
          ) : null}
          {status.code ? (
            <p className="mt-2">
              {t('modelSetup.signInCode')} <code>{status.code}</code>
            </p>
          ) : null}
          {status.signInUrl ? (
            <p className="mt-2 break-all text-[11px] text-muted">{status.signInUrl}</p>
          ) : null}
        </div>
      ) : null}
      {formOpen && !sourcesLoading ? (
        <div className="border-t border-solid border-line px-6 py-5">
          {!provider ? (
            <>
              <h3
                ref={chooserRef}
                tabIndex={-1}
                className="text-[14px] font-medium text-secondary focus:outline-none"
              >
                {t('modelSetup.chooseProvider')}
              </h3>
              <fieldset
                aria-label={t('modelSetup.chooseProvider')}
                className="m-0 mt-3 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-x-6 border-0 p-0"
              >
                {choices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    aria-label={choice.title}
                    disabled={!desktop || busy}
                    className="group flex min-h-16 items-center justify-between gap-3 border-b border-solid border-line px-0.5 py-3 text-left transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45"
                    onClick={() => choose(choice.id)}
                  >
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{choice.title}</span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {choice.description}
                      </span>
                    </span>
                    <ChevronRight
                      size={15}
                      className="shrink-0 text-muted group-hover:text-accent"
                    />
                  </button>
                ))}
              </fieldset>
            </>
          ) : (
            <>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-medium text-secondary">
                    {editing
                      ? t('modelSetup.editSource', { name: editing.title })
                      : providerLabel(provider)}
                  </h3>
                  {editing ? (
                    <p className="mt-1 text-[11px] text-muted">{providerLabel(provider)}</p>
                  ) : null}
                </div>
                {!editing ? (
                  <button
                    type="button"
                    className="text-button inline-flex items-center gap-1.5"
                    disabled={busy}
                    onClick={() => edit()}
                  >
                    <ChevronLeft size={13} />
                    {t('modelSetup.changeProvider')}
                  </button>
                ) : null}
              </div>

              <fieldset disabled={!desktop || busy} className="m-0 min-w-0 max-w-140 border-0 p-0">
                <legend className="sr-only">{providerLabel(provider)}</legend>
                <div className="flex flex-col gap-4">
                  <label className="field flex flex-col gap-2 text-[12px] text-secondary">
                    {t('modelSetup.sourceName')}
                    <input
                      ref={nameRef}
                      value={title}
                      maxLength={120}
                      onChange={(event) => setTitle(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  {compatible ? (
                    <label className="field flex flex-col gap-2 text-[12px] text-secondary">
                      {t('modelSetup.baseUrl')}
                      <input
                        value={baseUrl}
                        aria-label={t('modelSetup.baseUrl')}
                        onChange={(event) => {
                          reset();
                          setBaseUrl(event.target.value);
                        }}
                        placeholder="https://your-provider.example/v1"
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        aria-invalid={!!baseUrl && !endpoint}
                        aria-describedby={baseUrl && !endpoint ? `${hintId}-url` : undefined}
                      />
                      {baseUrl && !endpoint ? (
                        <span id={`${hintId}-url`} className="text-[11px]">
                          {t('modelSetup.invalidEndpoint')}
                        </span>
                      ) : null}
                    </label>
                  ) : null}
                  {needsKey ? (
                    <label className="field flex flex-col gap-2 text-[12px] text-secondary">
                      {t(compatible ? 'modelSetup.optionalKey' : 'modelSetup.apiKey')}
                      <input
                        type="password"
                        value={apiKey}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={8192}
                        onChange={(event) => {
                          reset();
                          setApiKey(event.target.value);
                        }}
                        aria-describedby={hintId}
                        placeholder={
                          editing?.hasCredential ? t('modelSetup.reuseCredential') : undefined
                        }
                      />
                    </label>
                  ) : null}
                </div>

                <p id={hintId} className="mt-3 text-[11px] leading-relaxed text-muted">
                  {t(
                    account
                      ? 'modelSetup.accountHint'
                      : provider === 'ollama'
                        ? 'modelSetup.ollamaHint'
                        : 'modelSetup.keyHint',
                  )}
                </p>
                {account ? (
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button type="button" className="button" onClick={() => void signIn()}>
                      {t('modelSetup.signIn')}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setAccountSelected(true);
                        setError('');
                      }}
                    >
                      {t('modelSetup.useAccount')}
                    </button>
                    {accountSelected ? (
                      <span role="status" className="w-full text-[11px] text-muted">
                        {t('modelSetup.accountSelected')}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {provider === 'ollama' ? (
                  <button type="button" className="button mt-4" onClick={() => void open('ollama')}>
                    {t('modelSetup.openOllama')}
                  </button>
                ) : null}

                {hasAuth ? (
                  <div className="mt-5 border-t border-solid border-line pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h4 className="text-[12px] font-medium text-secondary">
                          {t('modelSetup.viewModels')}
                        </h4>
                        {models.length ? (
                          <span role="status" className="mt-1 block text-[11px] text-muted">
                            {t('modelSetup.availableModels', { count: models.length })}
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="button"
                        disabled={!canLoadModels || (account && !accountSelected)}
                        onClick={() => void loadModels()}
                      >
                        <RefreshCw size={13} />
                        {t('modelSetup.loadModels')}
                      </button>
                    </div>
                    {models.length ? (
                      <ul
                        aria-label={t('modelSetup.viewModels')}
                        className="m-0 mt-3 max-h-44 list-none overflow-auto p-0"
                      >
                        {models.map((item) => (
                          <li
                            key={item.id}
                            className="border-t border-solid border-line py-2 text-[12px] text-secondary"
                          >
                            {account && item.id === 'default'
                              ? t('modelSetup.defaultModel')
                              : item.name || item.id}
                            {item.name && item.name !== item.id ? (
                              <span className="mt-0.5 block break-all text-[11px] text-muted">
                                {item.id}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-[11px] leading-relaxed text-muted">
                        {t(catalogEmpty ? 'modelSetup.noModels' : 'modelSetup.catalogNotLoaded')}
                      </p>
                    )}
                    {catalogEmpty || catalogFailed ? (
                      <details className="mt-3 text-[11px] text-muted">
                        <summary className="cursor-pointer">
                          {t('modelSetup.manualFallback')}
                        </summary>
                        <label className="field mt-3 flex flex-col gap-2 text-[12px] text-secondary">
                          {t('modelSetup.modelId')}
                          <input
                            value={model}
                            maxLength={512}
                            onChange={(event) => setModel(event.target.value)}
                            placeholder={t('modelSetup.modelPlaceholder')}
                            spellCheck={false}
                            autoCapitalize="none"
                            autoCorrect="off"
                            aria-invalid={!!model && !validModel}
                            aria-describedby={`${hintId}-fallback`}
                          />
                        </label>
                        <p id={`${hintId}-fallback`} className="mt-2 leading-relaxed">
                          {t(
                            model && !validModel
                              ? 'modelSetup.invalidModel'
                              : 'modelSetup.manualFallbackHint',
                          )}
                        </p>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </fieldset>

              {action === 'sign-in' ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <p role="status" className="text-[12px] text-secondary">
                    {t('modelSetup.signingIn')}
                  </p>
                  <button
                    type="button"
                    className="button"
                    disabled={canceling}
                    onClick={() => void cancel()}
                  >
                    {t('modelSetup.cancel')}
                  </button>
                  {status?.sourceMessage ? (
                    <p className="w-full text-[11px] text-muted">
                      {errorText(status.sourceMessage, apiKey)}
                    </p>
                  ) : null}
                  {status?.code ? (
                    <p className="w-full text-[12px] text-secondary">
                      {t('modelSetup.signInCode')} <code>{status.code}</code>
                    </p>
                  ) : null}
                  {status?.signInUrl ? (
                    <p className="w-full break-all text-[11px] text-muted">{status.signInUrl}</p>
                  ) : null}
                </div>
              ) : null}

              <footer className="mt-5 flex flex-wrap items-center gap-4 border-t border-solid border-line pt-5">
                <button
                  type="button"
                  className="button primary"
                  disabled={!canSave || busy}
                  onClick={() => void save()}
                >
                  {t(
                    action === 'save'
                      ? 'modelSetup.saving'
                      : editing
                        ? 'modelSetup.saveChanges'
                        : 'modelSetup.saveSource',
                  )}
                </button>
                {sources.length ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      reset();
                      setApiKey('');
                      requestedFocus.current = 'add';
                      setFormOpen(false);
                    }}
                  >
                    {t('modelSetup.cancelEdit')}
                  </button>
                ) : null}
                {action === 'models' ? (
                  <span role="status" className="text-[11px] text-muted">
                    {t('modelSetup.loadingModels')}
                  </span>
                ) : null}
              </footer>
            </>
          )}
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="form-error whitespace-pre-wrap border-t border-solid border-line px-6 py-4 text-[12px] text-secondary"
        >
          {error}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="border-t border-solid border-line px-6 py-3 text-[11px] text-muted"
        >
          {t('modelSetup.saved')}
        </p>
      ) : null}
    </section>
  );
}
