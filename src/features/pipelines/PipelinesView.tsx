import { ArrowRight, FolderOpen, Plus, Search, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Empty, NodeIcon, nodeMeta, time } from '../../components/ui';
import { type Example, examples } from '../../lib/examples';
import { useI18n } from '../../lib/i18n';
import type { NodeKind, Workspace } from '../../lib/types';
import { parsePipeline } from '../../lib/validation';

export function PipelinesView({
  workspaces,
  onOpen,
  onCreate,
  onImport,
  busy,
}: {
  workspaces: Workspace[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onImport: () => void;
  busy: boolean;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');
  const pipelines = useMemo(
    () =>
      workspaces
        .map((workspace) => {
          const pipeline = parsePipeline(workspace.source);
          return {
            workspace,
            pipeline,
            title: pipeline?.metadata.title ?? pipeline?.metadata.name ?? t('editor.pipelineDraft'),
          };
        })
        .filter(({ title, pipeline }) =>
          `${title} ${pipeline?.metadata.description ?? ''}`
            .toLocaleLowerCase(locale)
            .includes(query.trim().toLocaleLowerCase(locale)),
        )
        .sort((a, b) =>
          sort === 'name'
            ? a.title.localeCompare(b.title, locale)
            : b.workspace.updatedAt.localeCompare(a.workspace.updatedAt),
        ),
    [workspaces, query, sort, locale, t],
  );
  return (
    <section className="page pipelines-page pb-8.75 min-h-full">
      <div className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <h1>{t('navigation.pipelines')}</h1>
          <p>{t('pipelines.intro')}</p>
        </div>
        <div className="heading-actions flex items-center gap-2.5">
          <button type="button" className="button" disabled={busy} onClick={onImport}>
            <FolderOpen size={15} />
            {t('common.openPackage')}
          </button>
          <button
            type="button"
            className="button primary"
            data-tour="create-pipeline"
            onClick={onCreate}
          >
            <Plus size={15} />
            {t('shell.newPipeline')}
          </button>
        </div>
      </div>
      <div className="pipelines-toolbar flex items-center gap-4 mt-0 mb-5.5 mx-7.5">
        <label className="pipeline-search flex items-center gap-2.5 flex-1 border border-solid border-line rounded-[9px] text-muted bg-surface-raised px-3 py-0">
          <Search size={16} />
          <input
            aria-label={t('pipelines.search')}
            placeholder={t('pipelines.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="muted text-muted" role="status">
          {t('pipelines.count', { count: pipelines.length })}
        </span>
        <select
          aria-label={t('pipelines.sort')}
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="updated">{t('pipelines.updatedFirst')}</option>
          <option value="name">{t('pipelines.byName')}</option>
        </select>
      </div>
      {pipelines.length ? (
        <div className="pipeline-cards grid grid-cols-[repeat(auto-fill,_minmax(260px,_1fr))] gap-4.5 mx-7.5 my-0">
          {pipelines.map(({ workspace, pipeline, title }) => {
            const nodes = Object.entries(pipeline?.spec.nodes ?? {});
            return (
              <button
                type="button"
                className="pipeline-card min-w-0 text-left border border-solid border-line bg-surface-raised rounded-[16px] flex flex-col [transition:border-color_0.15s,_transform_0.15s] p-5.5"
                key={workspace.id}
                aria-label={t('pipelines.open', { name: title })}
                onClick={() => onOpen(workspace.id)}
              >
                <div className="pipeline-card-top flex items-center gap-2.5">
                  <span className="node-icon tint-green">
                    <Workflow size={20} />
                  </span>
                  <span className="pipeline-draft-state flex-1 text-right text-muted text-[10px]">
                    {t(
                      !pipeline
                        ? 'pipelines.invalid'
                        : workspace.source === workspace.savedSource
                          ? 'pipelines.saved'
                          : 'pipelines.changed',
                    )}
                  </span>
                  <ArrowRight size={17} />
                </div>
                <h2>{title}</h2>
                <p>{pipeline?.metadata.description || t('pipelines.noDescription')}</p>
                <div
                  className="pipeline-preview flex items-center gap-1.25 min-h-9 text-muted"
                  role="img"
                  aria-label={t('pipelines.nodes', { count: nodes.length })}
                >
                  {nodes.slice(0, 5).map(([id, node]) => (
                    <span className="pipeline-preview-step flex items-center gap-1.25" key={id}>
                      <span
                        title={t(nodeMeta[node.type]?.label ?? 'editor.pipeline')}
                        className={`node-icon tint-${nodeMeta[node.type]?.color ?? 'green'}`}
                      >
                        <NodeIcon kind={node.type} size={15} />
                      </span>
                    </span>
                  ))}
                  {nodes.length > 5 ? <small>+{nodes.length - 5}</small> : null}
                </div>
                <div className="pipeline-card-footer flex justify-between gap-2.5 mt-5 pt-4 border-t border-solid border-t-line text-[10px] text-muted">
                  <span>
                    {pipeline
                      ? t('pipelines.nodes', { count: nodes.length })
                      : t('pipelines.checkSource')}
                  </span>
                  <span>{time(workspace.updatedAt, locale)}</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <Empty
          icon={<Workflow size={28} />}
          title={t(workspaces.length ? 'pipelines.noMatches' : 'pipelines.empty')}
          action={
            <button
              type="button"
              className="button"
              onClick={workspaces.length ? () => setQuery('') : onCreate}
            >
              {t(workspaces.length ? 'pipelines.clearSearch' : 'shell.newPipeline')}
            </button>
          }
        >
          {t(workspaces.length ? 'pipelines.trySearch' : 'pipelines.emptyHint')}
        </Empty>
      )}
    </section>
  );
}

export function TemplateLibrary({ onSelect }: { onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const [category, setCategory] = useState<Example['category']>('starter');
  return (
    <div className="template-library">
      <fieldset
        className="template-categories underline-tabs flex border-b border-solid border-b-line gap-5.25 shrink-0 mt-2 mb-0 px-5.25 py-0 mx-7.5"
        aria-label={t('library.categories')}
      >
        {(['starter', 'block'] as const).map((value) => (
          <button
            type="button"
            key={value}
            className={category === value ? 'active' : ''}
            aria-pressed={category === value}
            onClick={() => setCategory(value)}
          >
            {t(`library.category.${value}`)}
          </button>
        ))}
      </fieldset>
      <p className="template-category-hint mt-4 mb-0 text-muted text-[12px] leading-[1.7] mx-7.5">
        {t(`library.hint.${category}`)}
      </p>
      <div
        className={`library-grid grid grid-cols-[repeat(3,_1fr)] gap-3.75 px-7.75 py-6.5 ${category === 'starter' ? 'starter-grid' : ''}`}
      >
        {examples
          .filter((example) => example.category === category)
          .map((example) => (
            <button
              type="button"
              key={example.id}
              className="template-card border border-solid border-line-strong rounded-[16px] bg-surface-raised text-left flex flex-col [transition:border-color_0.15s,_background_0.15s] p-5.5"
              onClick={() => onSelect(example.id)}
            >
              <span className={`node-icon tint-${category === 'starter' ? 'green' : 'violet'}`}>
                <NodeIcon
                  kind={
                    (
                      {
                        research: 'agent',
                        hello: 'llm',
                        'research-dossier': 'agent',
                        'reviewed-research': 'human',
                        'tic-tac-toe': 'code',
                        publication: 'human',
                        subpipeline: 'pipeline',
                        'artifact-mount': 'code',
                        local: 'llm',
                      } as Record<string, NodeKind>
                    )[example.id] ?? (example.id as NodeKind)
                  }
                  size={21}
                />
              </span>
              <h3>{t(example.titleKey)}</h3>
              <p>{t(example.descriptionKey)}</p>
              {example.resultKey ? (
                <div className="template-result text-foreground text-[11px] leading-[1.6] mt-3.25">
                  {t('library.result')}: {t(example.resultKey)}
                </div>
              ) : null}
              <div className="template-requirements flex flex-wrap gap-1.25 text-[10px] mt-3.5 leading-[1.8] text-muted">
                <span>{t('library.requires')}:</span>
                {example.requirements.length ? (
                  example.requirements.map((requirement) => (
                    <span
                      className="requirement border border-solid border-line rounded-[4px] px-1.25 py-0"
                      key={requirement}
                    >
                      {t(`library.requirement.${requirement}`)}
                    </span>
                  ))
                ) : (
                  <span>{t('library.noResources')}</span>
                )}
              </div>
              <span className="template-kind flex items-center justify-between mt-5 text-[9px] text-muted">
                {t(example.kindKey)}
                <ArrowRight size={14} />
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}
