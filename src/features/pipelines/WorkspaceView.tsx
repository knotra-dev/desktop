import {
  AlertTriangle,
  ArrowLeft,
  Braces,
  CheckCircle2,
  ChevronRight,
  Download,
  File,
  FileText,
  FolderOpen,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  Settings2,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseDocument } from 'yaml';
import SourceEditor from '../../components/editor/SourceEditor';
import GraphView from '../../components/graph/GraphView';
import { Empty, size } from '../../components/ui';
import { base64, decodeText, textBytes, unbase64 } from '../../lib/bytes';
import { connectionError, type PortConnection } from '../../lib/connections';
import { editorLayerKeys } from '../../lib/editorLabels';
import type { Resource } from '../../lib/engine/types';
import { useI18n } from '../../lib/i18n';
import { desktop } from '../../lib/native';
import { agentMcpSelection, nodeMcpResponseDefaults, nodeMcpSelection } from '../../lib/nodeMcp';
import { nodeModelSelection } from '../../lib/nodeModel';
import { nodeSandboxSelection } from '../../lib/nodeSandbox';
import type { SavedConnection, SavedMcpConnection } from '../../lib/setup';
import {
  type DataSchema,
  type Graph,
  record,
  type Validation,
  type Workspace,
} from '../../lib/types';
import { parsePipeline, validatePipeline } from '../../lib/validation';
import Inspector from './Inspector';
import WorkflowSetup from './WorkflowSetup';

export default function WorkspaceView({
  workspace,
  validation,
  onChange,
  onSave,
  onExport,
  onLibrary,
  onAddNode,
  onDelete,
  onNotify,
  engineConnected,
  onEngineRun,
  resourcesRequested,
  nodeRequested,
  nodeResourceRequested,
  engineResources = [],
  modelConnections = [],
  mcpConnections = [],
  onConnectModels,
  onConnectMcp,
  onConnectSandboxes,
}: {
  engineConnected?: boolean;
  engineResources?: Resource[];
  modelConnections?: SavedConnection[];
  mcpConnections?: SavedMcpConnection[];
  onConnectModels?: () => void;
  onConnectMcp?: () => void;
  onConnectSandboxes?: () => void;
  onEngineRun: () => void;
  resourcesRequested?: 'models' | 'mcp' | 'sandboxes' | 'secrets';
  nodeRequested?: string;
  nodeResourceRequested?: 'models' | 'mcp' | 'sandboxes' | 'secrets';
  workspace?: Workspace;
  validation: Validation;
  onChange: (
    source: string,
    files?: Workspace['files'],
    positions?: Workspace['positions'],
  ) => void;
  onSave: () => void;
  onExport: () => void;
  onLibrary: () => void;
  onAddNode: (scope: string[]) => void;
  onDelete: () => void;
  onNotify: (message: string) => void;
}) {
  const { t, locale, message } = useI18n();
  const [showPorts, setShowPorts] = useState(false);
  const [view, setView] = useState<'graph' | 'source' | 'files'>(
    resourcesRequested === 'secrets' ? 'source' : 'graph',
  );
  const [selected, setSelected] = useState<string>(() =>
    resourcesRequested
      ? ''
      : validation.pipeline?.spec.nodes.research
        ? 'research'
        : (Object.keys(validation.pipeline?.spec.nodes ?? {})[0] ?? ''),
  );

  useEffect(() => {
    if (nodeRequested) {
      const path = nodeRequested.split('/');
      setView('graph');
      setShowPorts(false);
      setScope(path.slice(0, -1));
      setSelected(path.at(-1) ?? '');
    }
  }, [nodeRequested]);

  const [requestedScope, setScope] = useState<string[]>([]);

  useEffect(() => {
    if (!resourcesRequested) return;

    setView(resourcesRequested === 'secrets' ? 'source' : 'graph');
    setSelected('');
    setScope([]);
  }, [resourcesRequested]);

  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string>();
  const [removeNode, setRemoveNode] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const pipeline = validation.pipeline;
  const { graph, scope } = useMemo(() => {
    let graph = pipeline?.spec;
    const scope: string[] = [];
    for (const id of requestedScope) {
      const node = graph?.nodes[id];
      if (!node || !['foreach', 'loop'].includes(node.type)) break;
      scope.push(id);
      graph = record(record(node[node.type]).body) as unknown as Graph;
    }
    return { graph, scope };
  }, [pipeline, requestedScope]);

  const importedGraphs = useMemo(() => {
    const graphs = new Map<string, Graph>();
    for (const file of workspace?.files ?? []) {
      if (!/\.ya?ml$/.test(file.path)) continue;
      try {
        const pipeline = parsePipeline(decodeText(file.content));
        if (pipeline) graphs.set(file.path, pipeline.spec);
      } catch {
        /* Validation reports unreadable imports. */
      }
    }
    return graphs;
  }, [workspace?.files]);

  const node = selected ? graph?.nodes[selected] : undefined;
  const scopeKey = scope.join('/');

  useEffect(() => {
    if (!nodeRequested || !nodeResourceRequested) return;

    const path = nodeRequested.split('/');
    if (selected !== path.at(-1) || scopeKey !== path.slice(0, -1).join('/')) return;

    const target = document.querySelector(
      nodeResourceRequested === 'models'
        ? '[data-tour="node-model"]'
        : nodeResourceRequested === 'sandboxes'
          ? '[data-tour="node-sandbox"]'
          : '[data-tour="node-mcp"]',
    );
    target?.scrollIntoView({ block: 'start' });
    target?.querySelector<HTMLElement>('select, input, button')?.focus({ preventScroll: true });
  }, [nodeRequested, nodeResourceRequested, selected, scopeKey]);

  const resourceLabels = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(graph?.nodes ?? {}).map(([id, node]) => {
          let label: string | undefined;
          if (['llm', 'agent'].includes(node.type)) {
            const model = pipeline?.spec.models?.[String(record(node[node.type]).model)];
            const source = modelConnections.find((source) => source.id === model?.connection);
            const modelId = model?.model ?? source?.defaultModel;
            label =
              source?.models.find((model) => model.id === modelId)?.name ??
              (typeof modelId === 'string' ? modelId : source?.title);
          } else if (node.type === 'code') {
            const profile = String(pipeline?.spec.sandboxes?.[node.sandbox ?? '']?.profile ?? '');
            const environment = engineResources.find(
              (resource) => resource.kind === 'sandbox' && resource.id === profile,
            );
            if (
              environment &&
              environment.title !== profile &&
              !environment.title.endsWith(` / ${profile}`)
            )
              label = environment.title;
            else if (profile === 'python_box') label = t('resources.pythonSandbox');
            else if (profile === 'node_box') label = t('resources.nodeSandbox');
            else if (profile) label = profile.replace(/[_-]+/g, ' ');
          }
          return [id, label];
        }),
      ),
    [graph, pipeline, modelConnections, engineResources, t],
  );
  const knownNodes = useRef({ scope: scopeKey, ids: new Set(Object.keys(graph?.nodes ?? {})) });

  useEffect(() => {
    if (!graph) return;

    const added =
      knownNodes.current.scope === scopeKey
        ? Object.keys(graph.nodes).find((id) => !knownNodes.current.ids.has(id))
        : undefined;
    knownNodes.current = { scope: scopeKey, ids: new Set(Object.keys(graph.nodes)) };
    if (added) {
      setSelected(added);
      setShowPorts(false);
    } else if (selected && !graph.nodes[selected]) setSelected(Object.keys(graph.nodes)[0] ?? '');
  }, [graph, selected, scopeKey]);

  const errors = validation.diagnostics.filter((d) => d.severity === 'error');

  function mutate(action: (document: ReturnType<typeof parseDocument>, path: string[]) => void) {
    if (!workspace || !pipeline) return;

    const document = parseDocument(workspace.source);
    const path = ['spec'];
    let g: Graph = pipeline.spec;
    for (const id of scope) {
      path.push('nodes', id, g.nodes[id].type, 'body');
      g = record(record(g.nodes[id][g.nodes[id].type]).body) as unknown as Graph;
    }

    action(document, path);
    const source = document.toString({ lineWidth: 110 });
    const check = validatePipeline(source, workspace.files, workspace.entrypoint);
    if (!check.pipeline) {
      onNotify(
        t('editor.changeNotSavedMessage', {
          message: message(
            check.diagnostics.find((d) => d.severity === 'error')?.message ??
              t('editor.invalidBlockConfiguration'),
          ),
        }),
      );
      return;
    }

    onChange(source);
  }

  function connect(connection: PortConnection) {
    if (!graph) return;

    const error = connectionError(graph, connection, importedGraphs);
    if (error) {
      onNotify(message(error));
      return;
    }

    mutate((doc, path) =>
      doc.setIn([...path, 'nodes', connection.target, 'inputs', connection.targetPort, 'bind'], {
        from: `nodes.${connection.source}.outputs.${connection.sourcePort}`,
      }),
    );
    setSelected(connection.target);
    setShowPorts(true);
    onNotify(
      t('editor.sourceConnectedToTarget', {
        source: `${connection.source}.${connection.sourcePort}`,
        target: `${connection.target}.${connection.targetPort}`,
      }),
    );
  }

  function openBody(id: string) {
    const n = graph?.nodes[id];
    if (n && ['foreach', 'loop'].includes(n.type)) {
      setScope([...scope, id]);
      const child = record(record(n[n.type]).body) as unknown as Graph;
      setSelected(Object.keys(child.nodes)[0]);
    }
  }
  if (!workspace)
    return (
      <Empty
        icon={<Workflow />}
        title={t('editor.makeRoomForYourNextIdea')}
        action={
          <button type="button" className="button primary" onClick={onLibrary}>
            <Plus size={16} />
            {t('editor.createPipeline')}
          </button>
        }
      >
        {t('editor.startFromAContractExampleOrOpenAn')}
      </Empty>
    );
  const file = workspace.files.find((f) => f.path === selectedFile);
  let text: string | undefined;
  if (file)
    try {
      text = decodeText(file.content);
    } catch {
      /* Binary file: show metadata. */
    }

  return (
    <div className="workspace-view flex flex-col h-full min-h-112.5">
      <header className="workspace-header flex shrink-0 items-center justify-between gap-6 px-6 py-3">
        <div className="workspace-title min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-3">
            <h1 title={pipeline?.metadata.title ?? pipeline?.metadata.name}>
              <span>
                {pipeline?.metadata.title ?? pipeline?.metadata.name ?? t('editor.pipelineDraft')}
              </span>
            </h1>
            <span
              className="heading-version max-w-32 truncate text-[11px] text-muted"
              title={pipeline?.metadata.version ? `v${pipeline.metadata.version}` : undefined}
            >
              {pipeline?.metadata.version ? `v${pipeline.metadata.version}` : t('editor.draft')}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] leading-4 text-muted">
            <span className="inline-flex items-center gap-1.5" aria-live="polite">
              {workspace.source !== workspace.savedSource ? (
                <span className="unsaved-dot title-unsaved" aria-hidden="true" />
              ) : null}
              {t(
                workspace.source !== workspace.savedSource
                  ? 'editor.unsavedDraft'
                  : 'editor.savedLocally',
              )}
            </span>
            <span aria-hidden="true">·</span>
            <span className="node-count">
              {t('editor.countNodes', { count: graph ? Object.keys(graph.nodes).length : '—' })}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-[12px] text-secondary transition-colors duration-150 hover:bg-surface-raised"
            onClick={onSave}
            title={t('editor.saveLocalDraftCtrlS')}
          >
            <Save size={14} />
            {t('common.save')}
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-4 text-[12px] font-medium text-[var(--base)] transition-opacity duration-150 hover:enabled:opacity-85"
            onClick={onEngineRun}
            data-tour="run"
            disabled={errors.length > 0}
            title={t(
              engineConnected
                ? 'editor.checkAndStartOnYourEngine'
                : desktop
                  ? 'modelSetup.connectHint'
                  : 'editor.connectAnEngineInSettings',
            )}
          >
            <Play size={14} />
            {t(
              engineConnected
                ? 'common.run'
                : desktop
                  ? 'modelSetup.connectAction'
                  : 'resources.connectEngine',
            )}
          </button>
          <PipelineActions key={workspace.id} onExport={onExport} onDelete={onDelete} />
        </div>
      </header>
      <div className="workspace-toolbar flex h-12 shrink-0 items-center justify-between gap-4 px-6">
        <div
          className="flex h-full shrink-0 items-stretch gap-1"
          role="tablist"
          aria-label={t('editor.pipelineView')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'graph'}
            className={`inline-flex items-center gap-2 border-b-2 border-solid px-3 text-[12px] transition-colors duration-150 ${view === 'graph' ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-foreground'}`}
            onClick={() => setView('graph')}
          >
            <Workflow size={15} />
            {t('editor.canvas')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'source'}
            className={`inline-flex items-center gap-2 border-b-2 border-solid px-3 text-[12px] transition-colors duration-150 ${view === 'source' ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-foreground'}`}
            onClick={() => setView('source')}
          >
            <Braces size={15} />
            {t('editor.code')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'files'}
            className={`inline-flex items-center gap-2 border-b-2 border-solid px-3 text-[12px] transition-colors duration-150 ${view === 'files' ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-foreground'}`}
            onClick={() => setView('files')}
          >
            <FolderOpen size={15} />
            {t('editor.files')}
            <span className="counter text-[11px] text-muted tabular-nums">
              {workspace.files.length + 1}
            </span>
          </button>
        </div>
        {view === 'graph' ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-[12px] text-secondary transition-colors duration-150 hover:bg-surface-raised aria-pressed:bg-surface-raised"
              aria-pressed={!selected}
              onClick={() => {
                setView('graph');
                setSelected('');
              }}
              disabled={!pipeline}
            >
              <Settings2 size={14} />
              {t('editor.workflow')}
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-lg border border-solid border-line-strong px-3 text-[12px] text-foreground transition-colors duration-150 hover:bg-surface-raised"
              data-tour="add-node"
              onClick={() => onAddNode(scope)}
              disabled={!pipeline}
            >
              <Plus size={15} />
              {t('editor.addNode')}
            </button>
          </div>
        ) : null}
      </div>
      {scope.length ? (
        <div className="scope-bar flex items-center justify-between text-[11px] border-b border-solid border-b-[var(--line)] text-muted bg-surface px-6.25 py-2.5">
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setScope(scope.slice(0, -1));
              setSelected(scope.at(-1) ?? '');
            }}
          >
            <ArrowLeft size={14} />
            {t('editor.parentGraph')}
          </button>
          <span>
            {scope.join(' / ')}
            <ChevronRight size={12} />
            {t('editor.body')}
          </span>
        </div>
      ) : null}
      <div className="workspace-body flex min-h-75 flex-1 border-t border-solid border-t-[var(--line)] overflow-hidden">
        {view === 'graph' ? (
          graph && pipeline ? (
            <>
              <GraphView
                key={workspace.id + scope.join('/')}
                graph={graph}
                resourceLabels={resourceLabels}
                positions={Object.fromEntries(
                  Object.entries(workspace.positions ?? {})
                    .filter(([key]) => key.startsWith(`${scope.join('/')}::`))
                    .map(([key, value]) => [key.split('::')[1], value]),
                )}
                onLayout={(positions) =>
                  onChange(workspace.source, undefined, {
                    ...workspace.positions,
                    ...Object.fromEntries(
                      Object.entries(positions).map(([id, position]) => [
                        `${scope.join('/')}::${id}`,
                        position,
                      ]),
                    ),
                  })
                }
                onMove={(id, position) =>
                  onChange(workspace.source, undefined, {
                    ...workspace.positions,
                    [`${scope.join('/')}::${id}`]: position,
                  })
                }
                importedGraphs={importedGraphs}
                selected={selected}
                onSelect={(id) => {
                  setSelected(id);
                  setShowPorts(false);
                  setRemoveNode(false);
                }}
                onOpenBody={openBody}
                onConnect={connect}
                onNotify={onNotify}
              />
              {node ? (
                <Inspector
                  showPorts={showPorts}
                  onWorkflow={() => setSelected('')}
                  key={selected + scope.join('/')}
                  resources={pipeline.spec}
                  modelConnections={modelConnections}
                  mcpConnections={mcpConnections}
                  engineResources={engineConnected ? engineResources : []}
                  engineConnected={engineConnected}
                  onConnectModels={onConnectModels}
                  onConnectMcp={onConnectMcp}
                  onConnectSandboxes={onConnectSandboxes}
                  onSandboxChange={(profile) => {
                    const selection = nodeSandboxSelection(pipeline, scope, selected, profile);
                    if (!selection) return;
                    mutate((doc, path) => {
                      doc.setIn(['spec', 'sandboxes', selection.alias], selection.resource);
                      doc.setIn([...path, 'nodes', selected, 'sandbox'], selection.alias);
                    });
                  }}
                  onMcpResponse={(response: 'structured' | 'content', schema: DataSchema) =>
                    mutate((doc, path) => {
                      doc.setIn([...path, 'nodes', selected, 'tool', 'response'], response);
                      doc.deleteIn([...path, 'nodes', selected, 'outputs', 'result', 'schemaRef']);
                      doc.setIn(
                        [...path, 'nodes', selected, 'outputs', 'result', 'schema'],
                        schema,
                      );
                    })
                  }
                  onMcpChange={(connection, tool, enabled) => {
                    if (node.type === 'agent') {
                      const selection = agentMcpSelection(
                        pipeline,
                        scope,
                        selected,
                        connection,
                        tool,
                        !!enabled,
                      );
                      if (!selection) return;
                      mutate((doc, path) => {
                        if (selection.alias && selection.resource)
                          doc.setIn(['spec', 'mcp', selection.alias], selection.resource);
                        doc.setIn([...path, 'nodes', selected, 'tools'], selection.tools);
                      });
                    } else {
                      const selection = nodeMcpSelection(pipeline, scope, selected, connection);
                      if (!selection) return;
                      const current = record(node.tool);
                      const previous = mcpConnections
                        .find(
                          (source) =>
                            source.id === pipeline.spec.mcp?.[String(current.server)]?.connection,
                        )
                        ?.tools.find((tool) => tool.name === current.name);
                      const next = mcpConnections
                        .find((source) => source.id === connection)
                        ?.tools.find((item) => item.name === tool);
                      const defaults = nodeMcpResponseDefaults(node, next, previous);
                      mutate((doc, path) => {
                        doc.setIn(['spec', 'mcp', selection.alias], selection.resource);
                        doc.setIn([...path, 'nodes', selected, 'tool', 'server'], selection.alias);
                        doc.setIn([...path, 'nodes', selected, 'tool', 'name'], tool);
                        if (defaults) {
                          doc.setIn(
                            [...path, 'nodes', selected, 'tool', 'response'],
                            defaults.response,
                          );
                          doc.setIn(
                            [...path, 'nodes', selected, 'outputs', 'result', 'schema'],
                            defaults.schema,
                          );
                        }
                      });
                    }
                  }}
                  onModelChange={(connection, model, parameters) => {
                    const selection = nodeModelSelection(
                      pipeline,
                      scope,
                      selected,
                      connection,
                      model,
                      parameters,
                    );
                    if (!selection) return;
                    mutate((doc, path) => {
                      doc.setIn(['spec', 'models', selection.alias], selection.resource);
                      doc.setIn([...path, 'nodes', selected, node.type, 'model'], selection.alias);
                    });
                  }}
                  files={workspace.files.map((file) => file.path)}
                  promptFiles={workspace.files
                    .filter((file) => {
                      if (!pipeline.spec.files?.includes(file.path)) return false;
                      try {
                        return (
                          unbase64(file.content).length <= 1048576 &&
                          !!decodeText(file.content).trim()
                        );
                      } catch {
                        return false;
                      }
                    })
                    .map((file) => file.path)}
                  onNotify={onNotify}
                  id={selected}
                  node={node}
                  graph={graph}
                  importedGraphs={importedGraphs}
                  onEdit={(key, value) =>
                    mutate((doc, path) => {
                      if (value === undefined) doc.deleteIn([...path, 'nodes', selected, key]);
                      else doc.setIn([...path, 'nodes', selected, key], value);
                    })
                  }
                  onSource={() => setView('source')}
                  onDuplicate={() =>
                    mutate((doc, path) => {
                      let id = `${selected}_copy`;
                      let i = 2;
                      while (graph.nodes[id]) id = `${selected}_copy${i++}`;
                      doc.setIn([...path, 'nodes', id], node);
                      setSelected(id);
                    })
                  }
                  onRemove={() => setRemoveNode(true)}
                  onBody={() => openBody(selected)}
                />
              ) : (
                <WorkflowSetup
                  showResources={resourcesRequested === 'secrets' ? undefined : resourcesRequested}
                  engineResources={engineConnected ? engineResources : []}
                  pipeline={pipeline}
                  graph={graph}
                  imports={importedGraphs}
                  scope={scope}
                  onGraphEdit={(key, value) =>
                    mutate((doc, path) => doc.setIn([...path, key], value))
                  }
                  onMetadata={(title) => mutate((doc) => doc.setIn(['metadata', 'title'], title))}
                  onResources={(kind, value) => mutate((doc) => doc.setIn(['spec', kind], value))}
                />
              )}
            </>
          ) : (
            <Empty
              icon={<Braces />}
              title={t('editor.theYamlNeedsALittleAttention')}
              action={
                <button type="button" className="button" onClick={() => setView('source')}>
                  {t('editor.openYamlEditor')}
                </button>
              }
            >
              {t('editor.fixTheParseOrStructuralErrorsBelowTo')}
            </Empty>
          )
        ) : view === 'source' ? (
          <div className="editor-wrap flex flex-col flex-1 min-h-0 min-w-0">
            <div className="editor-file border-b border-solid border-b-[var(--line)] flex items-center gap-2 text-secondary bg-surface text-[11px] shrink-0 px-5 py-3.25">
              <FileText size={14} />
              {workspace.entrypoint}
              <span>YAML 1.2 · UTF-8</span>
            </div>
            <SourceEditor source={workspace.source} onChange={onChange} />
            <div className="editor-status text-[10px] border-t border-solid border-t-[var(--line)] flex justify-between text-muted bg-surface px-5 py-2.5">
              {t('editor.countLines', { count: workspace.source.split('\n').length })}
              <span>{t('editor.yamlIsTheSourceOfTruthChangesUpdate')}</span>
            </div>
          </div>
        ) : (
          <div className="files-view flex flex-1 min-w-0 min-h-0">
            <div className="file-list w-62.5 border-r border-solid border-r-[var(--line)] bg-base shrink-0 overflow-auto px-2.75 py-3.75">
              <div className="file-list-title flex justify-between items-center text-[9px] tracking-[1.2px] text-muted pt-0.75 pb-3 px-1.75">
                {t('editor.packageFiles')}
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => upload.current?.click()}
                  aria-label={t('editor.addPackageFile')}
                >
                  <Plus size={16} />
                </button>
              </div>
              <button
                type="button"
                className={!selectedFile ? 'active' : ''}
                onClick={() => setSelectedFile(undefined)}
              >
                <FileText size={16} />
                <span>{workspace.entrypoint}</span>
                <small>{t('editor.entry')}</small>
              </button>
              {workspace.files.map((f) => (
                <button
                  type="button"
                  className={selectedFile === f.path ? 'active' : ''}
                  key={f.path}
                  onClick={() => setSelectedFile(f.path)}
                >
                  <File size={15} />
                  <span>{f.path}</span>
                </button>
              ))}
              <p>
                {t('editor.onlyFilesDeclaredIn')} <code>spec.files</code>{' '}
                {t('editor.belongToTheExportedPackage')}
              </p>
              <input
                ref={upload}
                hidden
                type="file"
                multiple
                onChange={async (e) => {
                  try {
                    const files = await Promise.all(
                      [...(e.target.files ?? [])].map(async (f) => ({
                        path: f.name,
                        content: base64(new Uint8Array(await f.arrayBuffer())),
                      })),
                    );
                    if (
                      files.some(
                        (f) =>
                          workspace.files.some(
                            (existing) => existing.path.toLowerCase() === f.path.toLowerCase(),
                          ) || f.path === workspace.entrypoint,
                      )
                    )
                      throw new Error(t('editor.aFileWithThisNameAlreadyExists'));
                    if (pipeline) {
                      const declared = pipeline.spec.files ?? [];
                      const additions = files
                        .map((f) => f.path)
                        .filter((p) => !declared.includes(p));
                      let source = workspace.source;
                      if (additions.length) {
                        const doc = parseDocument(source);
                        doc.setIn(['spec', 'files'], [...declared, ...additions]);
                        source = doc.toString();
                      }
                      onChange(source, [...workspace.files, ...files]);
                    } else onNotify(t('editor.fixThePipelineStructureBeforeAddingFiles'));
                  } catch (error) {
                    onNotify(String(error));
                  }
                  e.target.value = '';
                }}
              />
            </div>
            <div className="file-preview flex flex-col flex-1 min-w-0 min-h-0">
              {!selectedFile ? (
                <SourceEditor source={workspace.source} onChange={onChange} />
              ) : file && text !== undefined ? (
                <>
                  <div className="editor-file border-b border-solid border-b-[var(--line)] flex items-center gap-2 text-secondary bg-surface text-[11px] shrink-0 px-5 py-3.25">
                    <FileText size={14} />
                    {file.path}
                    <span>{size(unbase64(file.content).length, locale)} · UTF-8</span>
                  </div>
                  <SourceEditor
                    key={file.path}
                    source={text}
                    label="editor.packageFileContents"
                    onChange={(value) =>
                      onChange(
                        workspace.source,
                        workspace.files.map((f) =>
                          f.path === file.path ? { ...f, content: base64(textBytes(value)) } : f,
                        ),
                      )
                    }
                  />
                </>
              ) : (
                <Empty icon={<File />} title={selectedFile ?? t('editor.selectAFile')}>
                  {file
                    ? `${size(unbase64(file.content).length, locale)} · ${t('editor.binaryFilePreservedWithThePackage')}`
                    : t('editor.chooseAPackageFileToInspectItsContents')}
                </Empty>
              )}
            </div>
          </div>
        )}
      </div>
      {removeNode ? (
        <div className="inline-confirm flex items-center gap-3 text-[11px] bg-[rgb(var(--accent-rgb)_/_0.082)] border-t border-solid border-t-line text-danger px-5.5 py-3">
          <span>
            {t('editor.remove')} <strong>{selected}</strong>
            {t('editor.existingReferencesWillNeedToBeUpdatedIn')}
          </span>
          <button
            type="button"
            className="button danger small-button text-[11px] min-h-8 px-3 py-1.75"
            onClick={() => {
              mutate((doc, path) => doc.deleteIn([...path, 'nodes', selected]));
              setRemoveNode(false);
              setSelected('');
            }}
          >
            {t('editor.removeNode')}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('editor.keepNode')}
            onClick={() => setRemoveNode(false)}
          >
            <X size={17} />
          </button>
        </div>
      ) : null}
      <div className="validation-panel border-t border-solid border-t-[var(--line)] bg-surface shrink-0">
        <button
          type="button"
          className={`validation-summary flex items-center gap-2.25 text-[10px] w-full text-left text-accent px-5.5 py-3.25 ${errors.length ? 'has-errors' : ''}`}
          onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}
          aria-expanded={diagnosticsOpen}
        >
          {errors.length ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <strong>
            {errors.length
              ? t(
                  errors.length === 1
                    ? 'editor.countIssueToResolve'
                    : 'editor.countIssuesToResolve',
                  {
                    count: errors.length,
                  },
                )
              : t('editor.localChecksPassed')}
          </strong>
          <span>{t('editor.engineChecksPending')}</span>
          <ChevronRight
            size={14}
            className={diagnosticsOpen ? 'rotated [transform:rotate(90deg)]' : ''}
          />
          <small>{t(diagnosticsOpen ? 'editor.hideDiagnostics' : 'editor.showDiagnostics')}</small>
        </button>
        {diagnosticsOpen ? (
          <div
            className="diagnostics max-h-60 overflow-auto border-t border-solid border-t-line px-5.5 py-1.25"
            role="log"
          >
            {validation.diagnostics.map((d) => (
              <div
                className={`diagnostic flex gap-3 border-b border-solid border-b-line text-secondary px-0 py-3.25 diagnostic-${d.severity}`}
                key={`${d.layer}:${d.code}:${d.path}:${d.line ?? ''}:${d.message}`}
              >
                <span>{d.severity === 'error' ? <AlertTriangle size={14} /> : <ShieldIcon />}</span>
                <div>
                  <strong>{d.code}</strong>
                  <p>{message(d.message)}</p>
                  <code>
                    {d.path}
                    {d.line ? `:${d.line}` : ''} · {t(editorLayerKeys[d.layer])}
                  </code>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PipelineActions({ onExport, onDelete }: { onExport: () => void; onDelete: () => void }) {
  const { t } = useI18n();
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const initialItem = useRef('first');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const items = container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[initialItem.current === 'last' ? items.length - 1 : 0]?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        type="button"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-raised aria-expanded:bg-surface-raised"
        aria-label={t('editor.pipelineActions')}
        title={t('editor.pipelineActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          initialItem.current = 'first';
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            initialItem.current = event.key === 'ArrowUp' ? 'last' : 'first';
            if (open) {
              const items =
                container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
              items?.[initialItem.current === 'last' ? items.length - 1 : 0]?.focus();
            } else setOpen(true);
          } else if (open && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <MoreHorizontal size={19} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={t('editor.pipelineActions')}
          className="absolute top-full right-0 z-10 mt-2 w-60 max-w-[calc(100vw-48px)] rounded-xl bg-surface-raised p-1.5 shadow-[0_8px_24px_rgb(0_0_0_/_0.25)]"
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              close();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'ArrowDown'
                ? (index + 1) % items.length
                : event.key === 'ArrowUp'
                  ? (index - 1 + items.length) % items.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : undefined;
            if (next !== undefined) {
              event.preventDefault();
              items[next].focus();
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[12px] text-foreground hover:bg-surface-active focus-visible:bg-surface-active"
            onClick={() => {
              close();
              onExport();
            }}
          >
            <Download size={15} />
            {t('common.export')}
          </button>
          <div className="mx-2 my-1 border-t border-solid border-line" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[12px] text-danger hover:bg-surface-active focus-visible:bg-surface-active"
            onClick={() => {
              close();
              onDelete();
            }}
          >
            <Trash2 size={15} />
            {t('editor.deletePipeline')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ShieldIcon() {
  return <span className="dot inline-block w-1.5 h-1.5 bg-surface-raised rounded-full shrink-0" />;
}
