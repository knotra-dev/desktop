import { ArrowRight } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { effectiveAgentTools } from '../../lib/nodeMcp';
import type { McpTool, SavedMcpConnection } from '../../lib/setup';
import { type NodeDefinition, type Pipeline, record } from '../../lib/types';

type McpCatalog = Pick<SavedMcpConnection, 'id' | 'title' | 'tools' | 'allowedTools'>;

function toolTitle(tool: McpTool): string {
  return tool.title || tool.name.replace(/[_-]+/g, ' ');
}

export function NodeMcp({
  resource,
  name,
  connections,
  onChange,
  onConnect,
}: {
  resource: Record<string, unknown>;
  name: string;
  connections: McpCatalog[];
  onChange: (connection: string, tool: string) => void;
  onConnect?: () => void;
}) {
  const { t } = useI18n();
  const connection = String(resource.connection ?? '');
  const selected = connections.find((item) => item.id === connection);
  const tools = selected?.tools.filter((tool) => selected.allowedTools.includes(tool.name)) ?? [];
  const tool = selected?.tools.find((tool) => tool.name === name);
  return (
    <section data-tour="node-mcp" className="mb-6 flex min-w-0 flex-col gap-4">
      <label className="field flex flex-col gap-2 text-[11px] leading-relaxed text-muted">
        {t('editor.mcpServer')}
        <select
          aria-label={t('editor.mcpServer')}
          className="h-11 w-full"
          value={connection}
          onChange={(event) => {
            const next = connections.find((item) => item.id === event.target.value);
            if (!next) return;
            const available = next.tools.filter((tool) => next.allowedTools.includes(tool.name));
            onChange(
              next.id,
              available.find((tool) => tool.name === name)?.name ?? available[0]?.name ?? name,
            );
          }}
        >
          {!selected ? <option value={connection}>{t('editor.chooseMcpServer')}</option> : null}
          {connections.map((item) => (
            <option value={item.id} key={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </label>
      <label className="field flex flex-col gap-2 text-[11px] leading-relaxed text-muted">
        {t('editor.toolName')}
        <select
          aria-label={t('editor.toolName')}
          className="h-11 w-full"
          disabled={!selected}
          value={name}
          onChange={(event) => onChange(connection, event.target.value)}
        >
          {!tools.some((tool) => tool.name === name) ? (
            <option value={name} disabled>
              {name
                ? `${tool ? toolTitle(tool) : name} · ${t('editor.notAvailable')}`
                : t('editor.chooseMcpTool')}
            </option>
          ) : null}
          {tools.map((tool) => (
            <option value={tool.name} key={tool.name}>
              {toolTitle(tool)}
            </option>
          ))}
        </select>
        {tool?.description ? <small>{tool.description}</small> : null}
      </label>
      {!connections.length ? (
        <p className="text-[11px] leading-relaxed text-muted">{t('editor.mcpNotConnected')}</p>
      ) : null}
      {selected && tool && !selected.allowedTools.includes(name) ? (
        <p role="alert" className="text-[11px] leading-relaxed text-secondary">
          {t('editor.toolNotAllowed')}
        </p>
      ) : null}
      {onConnect ? (
        <button className="text-button self-start" type="button" onClick={onConnect}>
          {t('editor.connectMcp')}
          <ArrowRight size={12} />
        </button>
      ) : null}
    </section>
  );
}

export function AgentMcp({
  resources,
  node,
  connections,
  onChange,
  onToolsChange,
  onConnect,
}: {
  resources: Pipeline['spec'];
  node: NodeDefinition;
  connections: McpCatalog[];
  onChange: (connection: string, tool: string, enabled: boolean) => void;
  onToolsChange: (tools: Record<string, unknown>) => void;
  onConnect?: () => void;
}) {
  const { t } = useI18n();
  const effective = effectiveAgentTools(resources, node);
  const grants = record(effective.mcp) as Record<string, string[]>;
  const selected = (connection: string) =>
    Object.keys(grants)
      .filter((alias) => resources.mcp?.[alias]?.connection === connection)
      .flatMap((alias) => grants[alias]);
  const unavailable = Object.entries(grants).filter(
    ([alias]) =>
      !connections.some((connection) => connection.id === resources.mcp?.[alias]?.connection),
  );
  return (
    <section data-tour="node-mcp" className="mb-6">
      <h3 className="mb-2 text-[12px] font-medium text-ink">{t('editor.mcpTools')}</h3>
      <p className="mb-4 text-[11px] leading-relaxed text-muted">{t('editor.agentMcpHelp')}</p>
      {!connections.length ? (
        <p className="mb-4 text-[11px] leading-relaxed text-muted">{t('editor.mcpNotConnected')}</p>
      ) : null}
      {connections.map((connection) => {
        const active = selected(connection.id);
        const names = [
          ...new Set([
            ...connection.tools
              .filter((tool) => connection.allowedTools.includes(tool.name))
              .map((tool) => tool.name),
            ...active,
          ]),
        ];
        return (
          <fieldset key={connection.id} className="mb-4 min-w-0 border-0 p-0">
            <legend className="mb-2 text-[11px] font-medium text-secondary">
              {connection.title}
            </legend>
            {names.map((name) => {
              const tool = connection.tools.find((tool) => tool.name === name);
              const available = !!tool && connection.allowedTools.includes(name);
              return (
                <label
                  className="flex cursor-pointer items-start gap-2.5 py-2 text-[12px] leading-relaxed text-ink"
                  key={name}
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-accent"
                    checked={active.includes(name)}
                    onChange={(event) => onChange(connection.id, name, event.target.checked)}
                  />
                  <span className="min-w-0 break-words">
                    <span>{tool ? toolTitle(tool) : name}</span>
                    {!available ? (
                      <span className="ml-1 text-[11px] text-muted">
                        · {t('editor.notAvailable')}
                      </span>
                    ) : null}
                    {tool?.description ? (
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {tool.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        );
      })}
      {unavailable.map(([alias, names]) =>
        names.map((name) => (
          <label
            className="mb-2 flex items-start gap-2.5 text-[12px] leading-relaxed text-secondary"
            key={`${alias}:${name}`}
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 accent-accent"
              checked
              onChange={() => {
                const next = { ...grants, [alias]: names.filter((tool) => tool !== name) };
                if (!next[alias].length) delete next[alias];
                onToolsChange({ ...effective, mcp: next });
              }}
            />
            <span className="min-w-0 break-words">
              {name} · {t('editor.notAvailable')}
            </span>
          </label>
        )),
      )}
      {onConnect ? (
        <button className="text-button mt-1" type="button" onClick={onConnect}>
          {t('editor.connectMcp')}
          <ArrowRight size={12} />
        </button>
      ) : null}
    </section>
  );
}
