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
  Play,
  Plus,
  Save,
  Settings2,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseDocument } from 'yaml';
import SourceEditor from '../../components/editor/SourceEditor';
import GraphView from '../../components/graph/GraphView';
import { Empty, size } from '../../components/ui';
import { base64, decodeText, textBytes, unbase64 } from '../../lib/bytes';
import { connectionError, type PortConnection } from '../../lib/connections';
import { editorLayerKeys } from '../../lib/editorLabels';
import { useI18n } from '../../lib/i18n';
import { type Graph, record, type Validation, type Workspace } from '../../lib/types';
import { parsePipeline, validatePipeline } from '../../lib/validation';
import Inspector from './Inspector';
import WorkflowSetup from './WorkflowSetup';

export default function WorkspaceView({
  workspace,
  validation,
  onChange,
  onSave,
  onExport,
  onRun,
  onLibrary,
  onAddNode,
  onDelete,
  onNotify,
  demo,
  engineConnected,
  onEngineRun,
  resourcesRequested,
}: {
  engineConnected?: boolean;
  onEngineRun: () => void;
  resourcesRequested?: 'models' | 'mcp' | 'sandboxes' | 'secrets';
  workspace?: Workspace;
  validation: Validation;
  onChange: (
    source: string,
    files?: Workspace['files'],
    positions?: Workspace['positions'],
  ) => void;
  onSave: () => void;
  onExport: () => void;
  onRun: () => void;
  onLibrary: () => void;
  onAddNode: (scope: string[]) => void;
  onDelete: () => void;
  onNotify: (message: string) => void;
  demo: boolean;
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
  const [requestedScope, setScope] = useState<string[]>([]);
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
  const knownNodes = useRef(new Set(Object.keys(graph?.nodes ?? {})));
  useEffect(() => {
    if (!graph) return;
    const added = Object.keys(graph.nodes).find((id) => !knownNodes.current.has(id));
    knownNodes.current = new Set(Object.keys(graph.nodes));
    if (added) {
      setSelected(added);
      setShowPorts(false);
    } else if (selected && !graph.nodes[selected]) setSelected(Object.keys(graph.nodes)[0] ?? '');
  }, [graph, selected]);
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
      <header className="workspace-header flex items-center justify-between gap-5 pt-3.75 pb-3.5 shrink-0 px-6">
        <div className="workspace-title flex items-center gap-2.5 min-w-0">
          <h1 title={pipeline?.metadata.description}>
            <span>
              {pipeline?.metadata.title ?? pipeline?.metadata.name ?? t('editor.pipelineDraft')}
            </span>
          </h1>
          {workspace.source !== workspace.savedSource ? (
            <span
              className="unsaved-dot title-unsaved"
              role="img"
              title={t('editor.unsavedDraft')}
              aria-label={t('editor.unsavedDraft')}
            />
          ) : null}
          <span className="heading-version [font-family:ui-monospace,_monospace] text-muted border border-solid border-line text-[9px] rounded-[5px] px-1.5 py-0.5">
            {pipeline?.metadata.version ? `v${pipeline.metadata.version}` : t('editor.draft')}
          </span>
        </div>
        <div className="heading-actions flex items-center gap-2.5">
          <button
            type="button"
            className="button small-button text-[11px] min-h-8 px-3 py-1.75"
            onClick={onSave}
            title={t('editor.saveLocalDraftCtrlS')}
          >
            <Save size={14} />
            {t('common.save')}
          </button>
          <button
            type="button"
            className="button small-button text-[11px] min-h-8 px-3 py-1.75"
            onClick={onExport}
          >
            <Download size={14} />
            {t('common.export')}
          </button>
          <button
            type="button"
            className="button small-button primary text-[11px] min-h-8 px-3 py-1.75"
            onClick={onEngineRun}
            disabled={errors.length > 0}
            title={t(
              engineConnected
                ? 'editor.checkAndStartOnYourEngine'
                : 'editor.connectAnEngineInSettings',
            )}
          >
            <Play size={14} />
            {t(engineConnected ? 'common.run' : 'resources.connectEngine')}
          </button>
          {demo || pipeline?.metadata.name === 'research-brief' ? (
            <button
              type="button"
              className="button small-button primary text-[11px] min-h-8 px-3 py-1.75"
              onClick={onRun}
              disabled={!demo || errors.length > 0}
              title={t(
                demo
                  ? 'editor.runTheGuidedDemoWithSampleOutputs'
                  : 'editor.theUnchangedResearchBriefTemplateOffersAGuided',
              )}
            >
              <Play size={14} fill="currentColor" />
              {t('editor.runDemo')}
            </button>
          ) : null}
        </div>
      </header>
      <div className="workspace-toolbar flex justify-between items-center gap-3 pt-0 pb-3.25 bg-transparent min-h-12.25 px-6">
        <div
          className="segmented flex gap-1 bg-surface border border-solid border-line rounded-[30px] p-1"
          role="tablist"
          aria-label={t('editor.pipelineView')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'graph'}
            className={view === 'graph' ? 'active' : ''}
            onClick={() => setView('graph')}
          >
            <Workflow size={15} />
            {t('editor.canvas')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'source'}
            className={view === 'source' ? 'active' : ''}
            onClick={() => setView('source')}
          >
            <Braces size={15} />
            {t('editor.code')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'files'}
            className={view === 'files' ? 'active' : ''}
            onClick={() => setView('files')}
          >
            <FolderOpen size={15} />
            {t('editor.files')}
            <span className="counter text-[9px] bg-surface-active rounded-[3px] text-secondary px-1 py-px">
              {workspace.files.length + 1}
            </span>
          </button>
        </div>
        <div className="inline-row flex items-center gap-2.5">
          <span className="editor-guidance text-[10px] text-muted">
            {t('editor.dragAnOutputToAnInputSelectA')}
          </span>
          <button
            type="button"
            className="button small-button text-[11px] min-h-8 px-3 py-1.75"
            onClick={() => {
              setView('graph');
              setSelected('');
            }}
            disabled={!pipeline}
          >
            <Settings2 size={14} />
            {t('editor.workflow')}
          </button>
          <span className="small muted node-count text-[11px] text-muted">
            {t('editor.countNodes', {
              count: pipeline ? Object.keys(pipeline.spec.nodes).length : '—',
            })}
          </span>
          <button
            type="button"
            className="button small-button text-[11px] min-h-8 px-3 py-1.75"
            onClick={() => onAddNode(scope)}
            disabled={!pipeline}
          >
            <Plus size={15} />
            {t('editor.addNode')}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onDelete}
            aria-label={t('editor.deletePipeline')}
            title={t('editor.deletePipeline')}
          >
            <Trash2 size={15} />
          </button>
        </div>
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
                  files={workspace.files.map((file) => file.path)}
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
                  showResources={!!resourcesRequested && resourcesRequested !== 'secrets'}
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

function ShieldIcon() {
  return <span className="dot inline-block w-1.5 h-1.5 bg-surface-raised rounded-full shrink-0" />;
}
