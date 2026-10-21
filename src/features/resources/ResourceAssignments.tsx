import { ArrowUpRight } from 'lucide-react';
import type { Resource } from '../../lib/engine/types';
import { useI18n } from '../../lib/i18n';
import { effectiveAgentTools } from '../../lib/nodeMcp';
import type { SavedConnection, SavedMcpConnection } from '../../lib/setup';
import { type Graph, type NodeDefinition, type Pipeline, record } from '../../lib/types';

export type ResourceKind = 'models' | 'mcp' | 'sandboxes' | 'secrets';

export default function ResourceAssignments({
  pipeline,
  kind,
  models,
  mcp,
  engineResources,
  engineConnected,
  onEdit,
}: {
  pipeline: Pipeline;
  kind: ResourceKind;
  models: SavedConnection[];
  mcp: SavedMcpConnection[];
  engineResources: Resource[];
  engineConnected: boolean;
  onEdit: (path: string[]) => void;
}) {
  const { t } = useI18n();
  const uses: { path: string[]; node: NodeDefinition }[] = [];

  function visit(graph: Graph, scope: string[]) {
    for (const [id, node] of Object.entries(graph.nodes)) {
      const path = [...scope, id];
      if (
        (kind === 'models' && ['llm', 'agent'].includes(node.type)) ||
        (kind === 'mcp' && ['tool', 'agent'].includes(node.type)) ||
        (kind === 'sandboxes' && ['code', 'agent'].includes(node.type))
      )
        uses.push({ path, node });
      if (['foreach', 'loop'].includes(node.type)) {
        const body = record(record(node[node.type]).body);
        if (body.nodes) visit(body as unknown as Graph, path);
      }
    }
  }
  visit(pipeline.spec, []);
  const empty = {
    models: 'resources.noModelsDeclared',
    mcp: 'resources.noMcpToolsDeclared',
    sandboxes: 'resources.noSandboxesDeclared',
    secrets: 'resources.noSecretReferencesDeclared',
  } as const;
  const help = {
    models: 'resources.modelsHelp',
    mcp: 'resources.mcpHelp',
    sandboxes: 'resources.sandboxesHelp',
    secrets: 'resources.secretsHelp',
  } as const;
  const resourceTitle = (id: string, type: Resource['kind']) => {
    const item = engineResources.find((item) => item.id === id && item.kind === type);
    if (item && item.title !== id && !item.title.endsWith(` / ${id}`)) return item.title;
    if (type === 'sandbox' && id === 'python_box') return t('resources.pythonSandbox');
    if (type === 'sandbox' && id === 'node_box') return t('resources.nodeSandbox');
    if (!item) {
      if (!id) return '';
      if (type === 'sandbox' && !/^[a-f0-9]{12,}$/i.test(id))
        return id.replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
      return t(
        type === 'sandbox'
          ? 'resources.savedCodeEnvironment'
          : type === 'mcp'
            ? 'resources.savedMcpServer'
            : 'resources.savedModelSource',
      );
    }
    return t(
      type === 'sandbox'
        ? 'resources.codeEnvironment'
        : type === 'mcp'
          ? 'resources.connectedTools'
          : 'resources.modelSource',
    );
  };

  return (
    <section
      className="resource-usage mx-7.5 mb-8 min-w-0"
      aria-label={t('resources.usedByBlocks')}
    >
      <h2 className="m-0 text-[18px] font-medium text-foreground">{t('resources.usedByBlocks')}</h2>
      <p className="mt-2 mb-5 max-w-180 text-[13px] leading-6 text-secondary">{t(help[kind])}</p>
      {kind === 'secrets' ? (
        Object.keys(pipeline.spec.secrets ?? {}).length ? (
          <ul className="m-0 list-none p-0">
            {Object.keys(pipeline.spec.secrets ?? {}).map((name) => (
              <li key={name} className="border-t border-solid border-line py-4">
                <strong className="text-[13px] font-medium text-foreground">{name}</strong>
                <p className="mt-1 mb-0 text-[12px] text-secondary">
                  {t('resources.secretOnEngine')}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <h3 className="my-6 text-[14px] font-medium text-secondary">{t(empty[kind])}</h3>
        )
      ) : uses.length ? (
        <ul className="m-0 list-none p-0">
          {uses.map(({ path, node }) => {
            const config = record(node[node.type]);
            const name = path.map((id) => id.replace(/_/g, ' ')).join(' / ');
            let selected = '';
            let detail = '';
            let missing = false;
            if (kind === 'models') {
              const binding = pipeline.spec.models?.[String(config.model)] ?? {};
              const source = models.find((source) => source.id === binding.connection);
              selected = source?.title ?? resourceTitle(String(binding.connection ?? ''), 'model');
              missing =
                !!binding.connection &&
                !source &&
                !engineResources.some(
                  (item) =>
                    item.kind === 'model' &&
                    item.id === binding.connection &&
                    item.status === 'available',
                );
              const model = source?.models.find((model) => model.id === binding.model);
              detail = binding.model
                ? (model?.name ?? String(binding.model))
                : (source?.models.find((model) => model.id === source.defaultModel)?.name ??
                  source?.defaultModel ??
                  (selected ? t('editor.useProviderDefault') : ''));
            } else if (kind === 'sandboxes') {
              const binding = pipeline.spec.sandboxes?.[node.sandbox ?? ''];
              selected = resourceTitle(String(binding?.profile ?? ''), 'sandbox');
              missing =
                !!binding?.profile &&
                !engineResources.some(
                  (item) =>
                    item.kind === 'sandbox' &&
                    item.id === binding.profile &&
                    item.status === 'available',
                );
            } else {
              const grants =
                node.type === 'tool'
                  ? { [String(config.server ?? '')]: [String(config.name ?? '')] }
                  : (effectiveAgentTools(pipeline.spec, node).mcp as Record<string, string[]>);
              const descriptions: string[] = [];
              for (const [alias, tools] of Object.entries(grants)) {
                if (!tools.length) continue;
                const binding = pipeline.spec.mcp?.[alias];
                const source = mcp.find((source) => source.id === binding?.connection);
                const title =
                  source?.title ?? resourceTitle(String(binding?.connection ?? ''), 'mcp');
                if (
                  binding?.connection &&
                  !source &&
                  !engineResources.some(
                    (item) =>
                      item.kind === 'mcp' &&
                      item.id === binding.connection &&
                      item.status === 'available',
                  )
                )
                  missing = true;
                if (title)
                  descriptions.push(
                    `${title} · ${tools.map((name) => source?.tools.find((tool) => tool.name === name)?.title ?? name).join(', ')}`,
                  );
              }
              selected = descriptions.join('; ');
            }
            return (
              <li
                key={path.join('/')}
                data-resource-node={path.join('/')}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-solid border-line py-5"
              >
                <div className="min-w-0">
                  <h3 className="m-0 text-[13px] font-medium text-foreground wrap-anywhere">
                    {name}
                  </h3>
                  <p className="mt-1 mb-0 text-[13px] leading-6 text-secondary wrap-anywhere">
                    {selected || t('resources.chooseInBlock')}
                  </p>
                  {detail ? (
                    <p className="mt-0.5 mb-0 text-[12px] leading-5 text-muted wrap-anywhere">
                      {detail}
                    </p>
                  ) : null}
                  {missing ? (
                    <p className="mt-1 mb-0 text-[11px] leading-5 text-muted">
                      {t(
                        engineConnected
                          ? 'resources.savedSelectionUnavailable'
                          : 'resources.savedSelectionOffline',
                      )}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="button small-button shrink-0"
                  onClick={() => onEdit(path)}
                  aria-label={t('resources.setUpBlock', { name })}
                >
                  {t('editor.setup')} <ArrowUpRight size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="my-6">
          <h3 className="text-[14px] font-medium text-secondary">{t(empty[kind])}</h3>
          <button type="button" className="text-button mt-3" onClick={() => onEdit([])}>
            {t('resources.openPipeline')} <ArrowUpRight size={14} />
          </button>
        </div>
      )}
    </section>
  );
}
