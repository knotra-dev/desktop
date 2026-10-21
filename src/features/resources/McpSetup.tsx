import { Plus, RefreshCw, Trash2, Wrench } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { desktop } from '../../lib/native';
import {
  type McpTool,
  mcpTools,
  refreshMcpConnection,
  removeMcpConnection,
  type SavedMcpConnection,
  savedMcpConnections,
  saveMcpConnection,
} from '../../lib/setup';

export default function McpSetup() {
  const { t } = useI18n();
  const hintId = useId();
  const [servers, setServers] = useState<SavedMcpConnection[]>([]);
  const [loading, setLoading] = useState(desktop);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SavedMcpConnection>();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [tools, setTools] = useState<McpTool[]>();
  const [allowed, setAllowed] = useState<string[]>([]);
  const [action, setAction] = useState<'discover' | 'save' | 'refresh' | 'remove'>();
  const [error, setError] = useState('');
  const revision = useRef(0);
  const active = useRef(true);
  const nameInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const busy = loading || !!action;
  let endpoint = '';
  try {
    const address = new URL(url.trim());
    if (
      ['http:', 'https:'].includes(address.protocol) &&
      !address.username &&
      !address.password &&
      !address.search &&
      !address.hash
    )
      endpoint = address.href;
  } catch {
    /* The address stays editable until complete. */
  }
  const addressChanged = !!editing && endpoint !== editing.url;
  const needsNewToken = addressChanged && editing?.hasCredential && !token.trim() && !clearToken;
  const credentials = {
    ...(editing ? { id: editing.id } : {}),
    url: url.trim(),
    ...(token.trim() ? { token: token.trim() } : {}),
    ...(clearToken ? { clearToken: true } : {}),
  };
  const missing = allowed.filter((name) => !tools?.some((tool) => tool.name === name));
  function changed() {
    window.dispatchEvent(new Event('knotra-connections-changed'));
  }
  function fail(error: unknown, secret = token) {
    const text = error instanceof Error ? error.message : String(error);
    setError(secret.trim() ? text.replaceAll(secret.trim(), '…') : text);
  }
  useEffect(() => {
    active.current = true;
    if (!desktop) return;
    let current = 0;
    let subscribed = true;
    function load() {
      const request = ++current;
      void savedMcpConnections()
        .then((items) => {
          if (subscribed && active.current && request === current && Array.isArray(items))
            setServers(items);
        })
        .catch((error) => {
          if (subscribed && active.current && request === current) setError(String(error));
        })
        .finally(() => {
          if (subscribed && active.current && request === current) setLoading(false);
        });
    }
    load();
    window.addEventListener('knotra-connections-changed', load);
    return () => {
      active.current = false;
      subscribed = false;
      revision.current++;
      window.removeEventListener('knotra-connections-changed', load);
    };
  }, []);
  useEffect(() => {
    if (open) nameInput.current?.focus();
  }, [open]);
  function edit(server?: SavedMcpConnection) {
    revision.current++;
    setAction(undefined);
    setEditing(server);
    setTitle(server?.title ?? '');
    setUrl(server?.url ?? '');
    setToken('');
    setClearToken(false);
    setTools(server?.tools);
    setAllowed(server?.allowedTools ?? []);
    setError('');
    setOpen(true);
  }
  function invalidate() {
    revision.current++;
    setTools(undefined);
    setAllowed([]);
    setError('');
  }
  function close() {
    revision.current++;
    setOpen(false);
    setEditing(undefined);
    setToken('');
    setTools(undefined);
    setAction(undefined);
    setError('');
    requestAnimationFrame(() => addButton.current?.focus());
  }
  async function discover() {
    if (!endpoint || needsNewToken || busy) return;
    const current = ++revision.current;
    setAction('discover');
    setError('');
    try {
      const items = await mcpTools(credentials);
      if (!active.current || current !== revision.current) return;
      setTools(items);
      setAllowed(editing && !addressChanged ? editing.allowedTools : []);
    } catch (error) {
      if (active.current && current === revision.current) fail(error);
    } finally {
      if (active.current && current === revision.current) setAction(undefined);
    }
  }
  async function save() {
    if (!title.trim() || !tools || !allowed.length || needsNewToken || busy) return;
    const current = ++revision.current;
    setAction('save');
    setError('');
    try {
      const server = await saveMcpConnection({
        expectedRevision: editing?.revision,
        ...credentials,
        title: title.trim(),
        allowedTools: allowed,
      });
      changed();
      if (!active.current || current !== revision.current) return;
      setServers((items) => [...items.filter((item) => item.id !== server.id), server]);
      close();
    } catch (error) {
      if (active.current && current === revision.current) fail(error);
    } finally {
      if (active.current && current === revision.current) setAction(undefined);
    }
  }
  async function update(server: SavedMcpConnection, remove: boolean) {
    const current = ++revision.current;
    setAction(remove ? 'remove' : 'refresh');
    setError('');
    try {
      if (remove) {
        const items = await removeMcpConnection(server.id, server.revision);
        changed();
        if (active.current && current === revision.current) setServers(items);
      } else {
        const item = await refreshMcpConnection(server.id, server.revision);
        changed();
        if (active.current && current === revision.current)
          setServers((items) => items.map((server) => (server.id === item.id ? item : server)));
      }
    } catch (error) {
      if (active.current && current === revision.current) fail(error, '');
    } finally {
      if (active.current && current === revision.current) setAction(undefined);
    }
  }
  return (
    <section
      id="mcp-settings"
      data-tour="mcp-settings"
      className="settings-card mcp-setup mb-6 max-w-250 overflow-hidden rounded-[12px] border border-solid border-line bg-surface"
    >
      <header className="flex items-start justify-between gap-4 px-6 py-5">
        <div className="min-w-0">
          <h2 className="m-0 text-[18px] font-medium tracking-tight">{t('mcpSetup.title')}</h2>
          <p className="mt-1.5 mb-0 max-w-prose text-[12px] leading-relaxed text-muted">
            {t('mcpSetup.intro')}
          </p>
        </div>
        <button
          ref={addButton}
          data-add-mcp
          type="button"
          className="button shrink-0"
          disabled={!desktop || busy || open}
          onClick={() => edit()}
        >
          <Plus size={14} />
          {t('mcpSetup.add')}
        </button>
      </header>
      {!desktop ? (
        <p className="px-6 pb-5 text-[12px] leading-5 text-muted" role="status">
          {t('mcpSetup.desktopOnly')}
        </p>
      ) : null}
      {loading ? (
        <p className="px-6 pb-5 text-[12px] text-muted" role="status">
          {t('mcpSetup.loading')}
        </p>
      ) : null}
      {servers.length ? (
        <ul className="m-0 list-none p-0" aria-label={t('mcpSetup.savedServers')}>
          {servers.map((server) => (
            <li
              key={server.id}
              className="flex min-w-0 items-center gap-3 border-t border-solid border-line px-6 py-3.5"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                disabled={busy || open}
                onClick={() => edit(server)}
                aria-label={t('mcpSetup.edit', { name: server.title })}
              >
                <Wrench size={18} className="shrink-0 text-muted" />
                <span className="min-w-0">
                  <strong className="block text-[13px] font-medium text-secondary wrap-anywhere">
                    {server.title}
                  </strong>
                  <span className="mt-1 block text-[11px] text-muted wrap-anywhere">
                    {server.url}
                  </span>
                  <span className="mt-1 block text-[11px] text-secondary">
                    {t('mcpSetup.toolCount', {
                      count: server.allowedTools.filter((name) =>
                        server.tools.some((tool) => tool.name === name),
                      ).length,
                    })}
                  </span>
                  {server.allowedTools.some(
                    (name) => !server.tools.some((tool) => tool.name === name),
                  ) ? (
                    <span className="mt-1 block text-[11px] text-amber">
                      {t('mcpSetup.missingTools')}
                    </span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={busy || open}
                aria-label={t('mcpSetup.refresh', { name: server.title })}
                onClick={() => void update(server, false)}
              >
                <RefreshCw size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={busy || open}
                aria-label={t('mcpSetup.remove', { name: server.title })}
                onClick={() => void update(server, true)}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : desktop && !loading && !open ? (
        <p className="m-0 px-6 pb-5 text-[12px] leading-5 text-secondary">{t('mcpSetup.empty')}</p>
      ) : null}
      {open ? (
        <form
          className="border-t border-solid border-line px-6 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
            <label className="field mb-4 flex flex-col gap-2 text-[12px] text-secondary">
              {t('mcpSetup.name')}
              <input
                ref={nameInput}
                className="h-11"
                value={title}
                maxLength={200}
                placeholder={t('mcpSetup.namePlaceholder')}
                required
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="field mb-4 flex flex-col gap-2 text-[12px] text-secondary">
              {t('mcpSetup.url')}
              <input
                className="h-11"
                type="url"
                aria-label={t('mcpSetup.url')}
                aria-describedby={`${hintId}-url`}
                value={url}
                required
                placeholder="https://example.com/mcp"
                onChange={(event) => {
                  invalidate();
                  setUrl(event.target.value);
                }}
              />
              <span id={`${hintId}-url`} className="text-[11px] leading-5 text-muted">
                {t('mcpSetup.urlHelp')}
              </span>
            </label>
            <label className="field mb-4 flex flex-col gap-2 text-[12px] text-secondary">
              {t('mcpSetup.token')}
              <input
                className="h-11"
                type="password"
                aria-label={t('mcpSetup.token')}
                aria-describedby={`${hintId}-token`}
                autoComplete="off"
                value={token}
                disabled={clearToken}
                placeholder={editing?.hasCredential ? t('mcpSetup.tokenStored') : undefined}
                onChange={(event) => {
                  invalidate();
                  setToken(event.target.value);
                }}
              />
              <span id={`${hintId}-token`} className="text-[11px] leading-5 text-muted">
                {t(editing?.hasCredential ? 'mcpSetup.tokenKeep' : 'mcpSetup.tokenHelp')}
              </span>
            </label>
            {editing?.hasCredential ? (
              <label className="mb-4 flex items-center gap-2 text-[12px] text-secondary">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={clearToken}
                  onChange={(event) => {
                    invalidate();
                    setClearToken(event.target.checked);
                    setToken('');
                  }}
                />
                {t('mcpSetup.clearToken')}
              </label>
            ) : null}
            {needsNewToken ? (
              <p className="mb-4 text-[12px] leading-5 text-amber">
                {t('mcpSetup.tokenNewAddress')}
              </p>
            ) : null}
            <button
              type="button"
              className={tools ? 'button' : 'button primary'}
              disabled={!endpoint || needsNewToken || busy}
              onClick={() => void discover()}
            >
              <RefreshCw size={14} />
              {t(action === 'discover' ? 'mcpSetup.discovering' : 'mcpSetup.discover')}
            </button>
            {tools ? (
              <section className="mt-5" aria-label={t('mcpSetup.tools')}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="m-0 text-[13px] font-semibold text-foreground">
                    {t('mcpSetup.tools')}
                  </h3>
                  {tools.length ? (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        setAllowed(allowed.length ? [] : tools.map((tool) => tool.name))
                      }
                    >
                      {t(allowed.length ? 'mcpSetup.disableAll' : 'mcpSetup.enableAll')}
                    </button>
                  ) : null}
                </div>
                <p className="mb-3 text-[12px] leading-5 text-muted">
                  {t(tools.length ? 'mcpSetup.toolsHelp' : 'mcpSetup.noTools')}
                </p>
                <div className="max-h-80 overflow-auto rounded-[8px] border border-solid border-line px-3">
                  {tools.map((tool) => (
                    <label
                      key={tool.name}
                      className="flex items-start gap-3 border-b border-solid border-line py-3 last:border-0"
                    >
                      <input
                        className="mt-1 shrink-0 accent-accent"
                        type="checkbox"
                        aria-label={tool.title || tool.name.replace(/[_-]+/g, ' ')}
                        aria-describedby={tool.description ? `${hintId}-${tool.name}` : undefined}
                        checked={allowed.includes(tool.name)}
                        onChange={(event) =>
                          setAllowed((names) =>
                            event.target.checked
                              ? [...names, tool.name]
                              : names.filter((name) => name !== tool.name),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <strong className="block text-[12px] font-medium text-secondary wrap-anywhere">
                          {tool.title || tool.name.replace(/[_-]+/g, ' ')}
                        </strong>
                        {tool.description ? (
                          <span
                            id={`${hintId}-${tool.name}`}
                            className="mt-1 block text-[11px] leading-5 text-muted whitespace-pre-wrap wrap-anywhere"
                          >
                            {tool.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                  {missing.map((name) => (
                    <label
                      key={name}
                      className="flex items-start gap-3 border-t border-solid border-line py-3"
                    >
                      <input
                        className="mt-1 accent-accent"
                        type="checkbox"
                        checked
                        onChange={() =>
                          setAllowed((names) => names.filter((item) => item !== name))
                        }
                      />
                      <span className="text-[12px] text-amber wrap-anywhere">
                        {name} · {t('mcpSetup.unavailable')}
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            ) : null}
          </fieldset>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="button primary"
              disabled={busy || !title.trim() || !tools?.length || !allowed.length || needsNewToken}
            >
              {t(
                action === 'save'
                  ? 'mcpSetup.saving'
                  : editing
                    ? 'mcpSetup.saveChanges'
                    : 'mcpSetup.save',
              )}
            </button>
            <button type="button" className="button" disabled={action === 'save'} onClick={close}>
              {t('mcpSetup.cancel')}
            </button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p
          className="m-0 px-6 pb-5 text-[12px] leading-5 text-danger whitespace-pre-wrap wrap-anywhere"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
