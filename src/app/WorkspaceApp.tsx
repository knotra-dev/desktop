import { X } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { parseDocument } from 'yaml';
import { nodeMeta } from '../components/ui';
import { ArtifactsView, InboxView, RunsView } from '../features/demo/RunViews';
import { EngineArtifactsView } from '../features/engine/EngineArtifactsView';
import { EngineBanner } from '../features/engine/EngineBanner';
import { EngineInboxView } from '../features/engine/EngineInboxView';
import { EngineRunDialog } from '../features/engine/EngineRunDialog';
import { EngineRunsView } from '../features/engine/EngineRunsView';
import { PipelinesView } from '../features/pipelines/PipelinesView';
import { ConnectionsView, SettingsView } from '../features/resources/ResourceViews';
import { cancelDemo, createDemoRun, demoAvailable, respondDemo } from '../lib/demo';
import { useEngine } from '../lib/engine/useEngine';
import { examples, fromExample } from '../lib/examples';
import {
  LocaleContext,
  type TranslationValues,
  translateMessage,
  useTranslation,
} from '../lib/i18n';
import { desktop, exportFile, type OpenedPackage } from '../lib/native';
import { allowedFiles } from '../lib/package';
import { readBackup, STARTER_REVISION, type State, saveState } from '../lib/storage';
import { ThemeContext } from '../lib/theme';
import {
  type Artifact,
  type Json,
  type NodeKind,
  record,
  type Section,
  type Workspace,
} from '../lib/types';
import { parsePipeline, validatePipeline } from '../lib/validation';
import { usePackageTransfer } from './usePackageTransfer';
import {
  useDemoProgress,
  useWorkspacePersistence,
  useWorkspaceShortcuts,
} from './useWorkspaceEffects';
import {
  DeleteWorkspaceDialog,
  DemoRunDialog,
  EntrypointDialog,
  NodeDialog,
  PackageImportDialog,
  RestoreWorkspaceDialog,
  SearchDialog,
  TemplateDialog,
  type WorkspaceDialog,
} from './WorkspaceDialogs';
import { WorkspaceHeader, WorkspaceSidebar } from './WorkspaceShell';

const WorkspaceView = lazy(() => import('../features/pipelines/WorkspaceView'));

export function WorkspaceApp({ initial }: { initial: State }) {
  const [restoring, setRestoring] = useState<State>();
  const backupInput = useRef<HTMLInputElement>(null);
  const [addScope, setAddScope] = useState<string[]>([]);
  const [openResources, setOpenResources] = useState<'models' | 'mcp' | 'sandboxes' | 'secrets'>();
  const [state, setState] = useState<State>(initial);
  const t = useTranslation(state.locale);
  const [section, setSection] = useState<Section>('pipelines');
  const [pipelinePage, setPipelinePage] = useState<'list' | 'editor'>('list');
  const [dialog, setDialog] = useState<WorkspaceDialog>();
  const [toast, setToast] = useState<{
    message: string;
    values?: TranslationValues;
    raw?: boolean;
  }>({
    message: '',
  });
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState('Reliable AI workflows');
  const [activeRun, setActiveRun] = useState<string>();
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, Record<string, string>>>({});
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);
  useLayoutEffect(() => {
    document.documentElement.lang = state.locale;
    document.title = t('app.title');
  }, [state.locale, t]);
  const workspace = state.workspaces.find((w) => w.id === state.activeId) ?? state.workspaces[0];
  const { source, files, entrypoint } = workspace ?? {};
  const validation = useMemo(
    () =>
      source === undefined ? { diagnostics: [] } : validatePipeline(source, files, entrypoint),
    [source, files, entrypoint],
  );
  const names = useMemo(
    () =>
      new Map(
        state.workspaces.map((w) => {
          const p = parsePipeline(w.source);
          return [w.id, p?.metadata.title ?? p?.metadata.name ?? t('editor.pipelineDraft')];
        }),
      ),
    [state.workspaces, t],
  );
  const [runMode, setRunMode] = useState<'demo' | 'engine'>('demo');
  const closeDialog = useCallback(() => setDialog(undefined), []);
  const notify = useCallback(
    (message: string, values?: TranslationValues) => setToast({ message, values }),
    [],
  );
  const {
    busy,
    fileInput,
    folderInput,
    entries,
    pickedEntry,
    setPickedEntry,
    importBrowser,
    confirmEntry,
    exportCurrent,
    openImport,
  } = usePackageTransfer(workspace, validation, addWorkspace, setDialog, notify);
  const notifyRaw = useCallback((message: string) => setToast({ message, raw: true }), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset scrolling when the visible route, workspace or run changes.
  useLayoutEffect(() => {
    document.querySelector('.main-content')?.scrollTo(0, 0);
  }, [section, pipelinePage, workspace?.id, runMode, activeRun]);
  const engine = useEngine(notifyRaw);
  const currentReviewScope = engine.sessionKey ?? 'offline';
  const waiting =
    state.runs.filter((r) => r.status === 'waiting_human').length +
    (engine.info ? engine.requests.filter((request) => request.status === 'open').length : 0);
  useEffect(() => {
    if (engine.info) setRunMode('engine');
  }, [engine.info]);
  const stateRef = useWorkspacePersistence(state, notify);
  useEffect(() => {
    if (!toast.message) return;
    const timer = setTimeout(() => setToast({ message: '' }), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useDemoProgress(state.runs, setState, notify);
  const saveDraft = useCallback(() => {
    const current = stateRef.current;
    const w = current.workspaces.find((w) => w.id === current.activeId);
    if (!w) return;
    setState((s) => ({
      ...s,
      workspaces: s.workspaces.map((current) =>
        current.id === w.id ? { ...current, savedSource: current.source } : current,
      ),
    }));
    notify('messages.draftSavedInThisLocalWorkspace');
  }, [notify, stateRef]);
  useWorkspaceShortcuts(saveDraft, section, pipelinePage, dialog, setDialog, setQuery);
  function selectWorkspace(id: string) {
    setOpenResources(undefined);
    setState((s) => ({ ...s, activeId: id }));
    setSection('pipelines');
    setPipelinePage('editor');
    closeDialog();
  }
  function addWorkspace(opened: OpenedPackage) {
    setOpenResources(undefined);
    const w: Workspace = {
      id: crypto.randomUUID(),
      source: opened.source,
      savedSource: opened.source,
      files: opened.files,
      entrypoint: opened.entrypoint,
      updatedAt: new Date().toISOString(),
    };
    setState((s) => ({ ...s, workspaces: [...s.workspaces, w], activeId: w.id }));
    setSection('pipelines');
    setPipelinePage('editor');
    closeDialog();
    notify('messages.pipelinePackageAddedToYourLocalWorkspace');
  }
  function selectExample(id: string) {
    setOpenResources(undefined);
    const example = examples.find((e) => e.id === id);
    if (!example) return;
    const w = fromExample(example, state.locale);
    setState((s) => ({ ...s, workspaces: [...s.workspaces, w], activeId: w.id }));
    setSection('pipelines');
    setPipelinePage('editor');
    closeDialog();
  }
  function startDialog() {
    setRunMode('demo');
    const demo = state.workspaces.find(demoAvailable);
    if (!demo) {
      const w = fromExample(examples[0]);
      setState((s) => ({ ...s, workspaces: [...s.workspaces, w], activeId: w.id }));
    } else setState((s) => ({ ...s, activeId: demo.id }));
    setDialog('run');
  }
  function startRun() {
    if (!workspace) return;
    try {
      const run = createDemoRun(workspace, topic);
      setState((s) => ({ ...s, runs: [run, ...s.runs] }));
      setActiveRun(run.id);
      setSection('runs');
      closeDialog();
    } catch (e) {
      notify(String(e));
    }
  }
  function respond(id: string, request: string, response: Record<string, Json>) {
    const current = state.runs.find((r) => r.id === id);
    if (!current) throw new Error('Run no longer exists.');
    const updated = respondDemo(current, request, response);
    setState((s) => ({
      ...s,
      runs: s.runs.map((run) =>
        run.id === id && run.status === 'waiting_human' && run.requestId === request
          ? updated
          : run,
      ),
    }));
    notify('messages.reviewResponseAcceptedTheDemoIsContinuing');
  }
  function addNode(kind: NodeKind) {
    if (!workspace || !validation.pipeline) return;
    const example = examples.find((e) => e.id === (kind === 'pipeline' ? 'subpipeline' : kind));
    if (!example) return;
    const p = parsePipeline(example.source);
    if (!p) return;
    const node = structuredClone(Object.values(p.spec.nodes)[0]);
    const current = validation.pipeline;
    const doc = parseDocument(workspace.source);
    const path = ['spec'];
    let graph = current.spec as import('../lib/types').Graph;
    for (const parent of addScope) {
      const outer = graph.nodes[parent];
      if (!outer || !['foreach', 'loop'].includes(outer.type)) {
        notify('messages.theSelectedBodyIsNoLongerAvailable');
        return;
      }
      path.push('nodes', parent, outer.type, 'body');
      graph = record(record(outer[outer.type]).body) as unknown as import('../lib/types').Graph;
    }
    let id: string = kind;
    let i = 2;
    while (id in graph.nodes) id = `${kind}_${i++}`;
    // Also copy resources and graph inputs used by the contract template, without overwriting existing aliases.
    for (const key of ['models', 'mcp', 'sandboxes', 'secrets', 'schemas'] as const)
      if (p.spec[key]) doc.setIn(['spec', key], { ...p.spec[key], ...current.spec[key] });
    if (p.spec.inputs) doc.setIn([...path, 'inputs'], { ...p.spec.inputs, ...graph.inputs });
    for (const port of Object.values(node.inputs ?? {}))
      if (port.bind?.from?.startsWith('nodes.')) {
        const schema = record(port.schema);
        port.bind = {
          value:
            schema.type === 'integer'
              ? 0
              : schema.type === 'array'
                ? []
                : schema.type === 'object'
                  ? {}
                  : 'Example input',
        };
      }
    doc.setIn([...path, 'nodes', id], node);
    const additions = example.files.filter(
      (f) => !workspace.files.some((existing) => existing.path === f.path),
    );
    if (additions.length)
      doc.setIn(
        ['spec', 'files'],
        [...new Set([...(current.spec.files ?? []), ...(p.spec.files ?? [])])],
      );
    setState((s) => ({
      ...s,
      workspaces: s.workspaces.map((w) =>
        w.id === workspace.id
          ? {
              ...w,
              source: doc.toString(),
              files: [...w.files, ...additions],
              updatedAt: new Date().toISOString(),
            }
          : w,
      ),
    }));
    closeDialog();
    notify('messages.kindNodeAddedChooseItsModelOrTool', {
      kind: nodeMeta[kind].label,
    });
  }
  async function exportArtifact(artifact: Artifact) {
    try {
      await exportFile(artifact.name, artifact.content, artifact.mediaType);
    } catch (e) {
      notify(String(e));
    }
  }
  function navigate(next: Section) {
    setOpenResources(undefined);
    setSection(next);
    if (next === 'pipelines') setPipelinePage('list');
    if (next === 'runs') setActiveRun(undefined);
  }
  async function restoreWorkspace() {
    if (!restoring) return;
    try {
      await saveState(restoring);
      await engine.disconnect();
      setState(restoring);
      setActiveRun(undefined);
      setSection('pipelines');
      setPipelinePage('list');
      setRunMode('demo');
      setRestoring(undefined);
      closeDialog();
      notify('messages.workspaceBackupRestored');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <ThemeContext.Provider value={state.theme}>
      <LocaleContext.Provider value={state.locale}>
        <div
          className={`app-shell flex h-dvh min-h-160 min-w-245 overflow-hidden bg-base ${state.compact ? 'compact' : ''}`}
        >
          <WorkspaceSidebar
            state={state}
            section={section}
            pipelinePage={pipelinePage}
            workspace={workspace}
            names={names}
            waiting={waiting}
            engineConnected={!!engine.info}
            navigate={navigate}
            selectWorkspace={selectWorkspace}
            onSearch={() => {
              setQuery('');
              setDialog('search');
            }}
            onCreate={() => setDialog('library')}
            onToggleNavigation={() => setState((s) => ({ ...s, compact: !s.compact }))}
          />
          <main className="main flex flex-col flex-1 min-w-0 bg-base">
            <WorkspaceHeader
              section={section}
              pipelinePage={pipelinePage}
              workspace={workspace}
              names={names}
              busy={busy}
              waiting={waiting}
              navigate={navigate}
              openImport={openImport}
            />
            <div
              className={`main-content flex-1 min-h-0 overflow-auto [scrollbar-gutter:stable] ${['runs', 'inbox', 'artifacts'].includes(section) ? 'execution-view' : ''}`}
            >
              {['runs', 'inbox', 'artifacts'].includes(section) ? (
                <>
                  <nav
                    className="engine-mode-tabs underline-tabs flex border-b border-solid border-b-line gap-5.25 shrink-0 min-h-10 px-6 py-0"
                    aria-label={t('shell.runMode')}
                  >
                    <button
                      type="button"
                      className={runMode === 'engine' ? 'active' : ''}
                      onClick={() => setRunMode('engine')}
                    >
                      {t('resources.engine')}
                    </button>
                    <button
                      type="button"
                      className={runMode === 'demo' ? 'active' : ''}
                      onClick={() => setRunMode('demo')}
                    >
                      {t('shell.guidedDemo')}
                    </button>
                  </nav>
                  {runMode === 'engine' ? (
                    <EngineBanner engine={engine} onSettings={() => navigate('settings')} />
                  ) : null}
                </>
              ) : null}
              {section === 'pipelines' && pipelinePage === 'list' ? (
                <PipelinesView
                  workspaces={state.workspaces}
                  onOpen={selectWorkspace}
                  onCreate={() => setDialog('library')}
                  onImport={openImport}
                  busy={busy}
                />
              ) : section === 'pipelines' ? (
                <Suspense
                  fallback={
                    <div className="loading text-muted p-12.5">{t('shell.openingWorkspace')}</div>
                  }
                >
                  <WorkspaceView
                    resourcesRequested={openResources}
                    key={workspace?.id ?? 'empty'}
                    workspace={workspace}
                    validation={validation}
                    engineConnected={!!engine.info && !engine.error}
                    onEngineRun={() => {
                      if (engine.info && !engine.error) setDialog('engine-run');
                      else navigate('settings');
                    }}
                    demo={workspace ? demoAvailable(workspace) : false}
                    onChange={(source, files, positions) => {
                      if (!workspace) return;
                      setState((s) => ({
                        ...s,
                        workspaces: s.workspaces.map((w) =>
                          w.id === workspace.id
                            ? {
                                ...w,
                                source,
                                files: files ?? w.files,
                                positions: positions ?? w.positions,
                                updatedAt: new Date().toISOString(),
                              }
                            : w,
                        ),
                      }));
                    }}
                    onSave={saveDraft}
                    onExport={() => void exportCurrent()}
                    onRun={() => setDialog('run')}
                    onLibrary={() => setDialog('library')}
                    onAddNode={(scope) => {
                      setAddScope(scope);
                      setDialog('node');
                    }}
                    onDelete={() => setDialog('delete')}
                    onNotify={notify}
                  />
                </Suspense>
              ) : section === 'runs' && runMode === 'engine' ? (
                <EngineRunsView
                  engine={engine}
                  activeId={activeRun}
                  onSelect={setActiveRun}
                  onReview={() => setSection('inbox')}
                />
              ) : section === 'runs' ? (
                <RunsView
                  runs={state.runs}
                  activeId={activeRun}
                  onSelect={setActiveRun}
                  onCancel={(id) =>
                    setState((s) => ({
                      ...s,
                      runs: s.runs.map((r) => (r.id === id ? cancelDemo(r) : r)),
                    }))
                  }
                  onReview={(id) => {
                    setActiveRun(id);
                    setSection('inbox');
                  }}
                  onStart={startDialog}
                />
              ) : section === 'inbox' && runMode === 'engine' ? (
                <EngineInboxView
                  key={currentReviewScope}
                  engine={engine}
                  responseDrafts={reviewDrafts[currentReviewScope] ?? {}}
                  onResponseDraftsChange={(update) =>
                    setReviewDrafts((current) => ({
                      ...current,
                      [currentReviewScope]:
                        typeof update === 'function'
                          ? update(current[currentReviewScope] ?? {})
                          : update,
                    }))
                  }
                  onRun={(id) => {
                    setActiveRun(id);
                    setSection('runs');
                  }}
                />
              ) : section === 'inbox' ? (
                <InboxView
                  runs={state.runs}
                  onRespond={respond}
                  onRun={(id) => {
                    setActiveRun(id);
                    setSection('runs');
                  }}
                />
              ) : section === 'artifacts' && runMode === 'engine' ? (
                <EngineArtifactsView engine={engine} />
              ) : section === 'artifacts' ? (
                <ArtifactsView runs={state.runs} onExport={exportArtifact} />
              ) : section === 'connections' ? (
                <ConnectionsView
                  engine={engine}
                  pipeline={validation.pipeline}
                  onSource={(kind) => {
                    setOpenResources(kind);
                    setSection('pipelines');
                    setPipelinePage('editor');
                  }}
                />
              ) : (
                <SettingsView
                  onRestore={() => backupInput.current?.click()}
                  engine={engine}
                  key={state.engineUrl}
                  engineUrl={state.engineUrl}
                  desktop={desktop}
                  theme={state.theme}
                  language={state.locale}
                  onLanguage={(locale) => setState((s) => ({ ...s, locale }))}
                  onTheme={(theme) => setState((s) => ({ ...s, theme }))}
                  onSaveUrl={(engineUrl) => {
                    if (engineUrl !== state.engineUrl)
                      void engine.disconnect().catch((error) => notifyRaw(String(error)));
                    setState((s) => ({ ...s, engineUrl }));
                  }}
                  onBackup={() => {
                    void exportFile(
                      'knotra-workspace-backup.json',
                      JSON.stringify(state, null, 2),
                      'application/json',
                    ).catch((error) => notify(String(error)));
                  }}
                  onNotify={notify}
                />
              )}
            </div>
          </main>
          <input
            ref={backupInput}
            hidden
            type="file"
            accept=".json,application/json"
            aria-label={t('shell.restoreWorkspaceBackup')}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              try {
                if (file.size > 96 * 1024 * 1024)
                  throw new Error('Workspace backup exceeds 96 MiB.');
                setRestoring({
                  ...readBackup(await file.text()),
                  starterRevision: STARTER_REVISION,
                });
                setDialog('restore');
              } catch (error) {
                notify(error instanceof Error ? error.message : String(error));
              }
            }}
          />
          {dialog === 'restore' && restoring ? (
            <RestoreWorkspaceDialog
              restoring={restoring}
              onClose={closeDialog}
              onRestore={restoreWorkspace}
            />
          ) : null}
          {dialog === 'engine-run' && workspace && engine.info ? (
            <EngineRunDialog
              workspace={{ ...workspace, ...allowedFiles(workspace) }}
              engine={engine}
              onClose={closeDialog}
              onStarted={(id) => {
                setActiveRun(id);
                setRunMode('engine');
                setSection('runs');
              }}
            />
          ) : null}
          {dialog === 'library' ? (
            <TemplateDialog
              onClose={closeDialog}
              onSelect={selectExample}
              onCreate={addWorkspace}
            />
          ) : null}
          {dialog === 'node' ? <NodeDialog onClose={closeDialog} onAdd={addNode} /> : null}
          {dialog === 'run' ? (
            <DemoRunDialog
              onClose={closeDialog}
              topic={topic}
              onTopic={setTopic}
              onStart={startRun}
            />
          ) : null}
          {dialog === 'search' ? (
            <SearchDialog
              onClose={closeDialog}
              workspaces={state.workspaces}
              names={names}
              query={query}
              onQuery={setQuery}
              onSelect={selectWorkspace}
              onNavigate={navigate}
            />
          ) : null}
          {dialog === 'delete' ? (
            <DeleteWorkspaceDialog
              onClose={closeDialog}
              name={workspace ? names.get(workspace.id) : undefined}
              onDelete={() => {
                setState((s) => {
                  const workspaces = s.workspaces.filter((w) => w.id !== workspace?.id);
                  return { ...s, workspaces, activeId: workspaces[0]?.id ?? '' };
                });
                setPipelinePage('list');
                closeDialog();
              }}
            />
          ) : null}
          {dialog === 'import' ? (
            <PackageImportDialog
              onClose={closeDialog}
              fileInput={fileInput}
              folderInput={folderInput}
            />
          ) : null}
          {dialog === 'entrypoint' ? (
            <EntrypointDialog
              onClose={closeDialog}
              entries={entries}
              pickedEntry={pickedEntry}
              onPick={setPickedEntry}
              onConfirm={confirmEntry}
            />
          ) : null}
          <input
            hidden
            ref={fileInput}
            aria-label={t('shell.importPipelinePackage')}
            type="file"
            multiple
            accept=".yaml,.yml,.zip,.txt,.json,.py,.md"
            onChange={(e) => {
              void importBrowser([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <input
            hidden
            ref={folderInput}
            type="file"
            {...{ webkitdirectory: '', directory: '' }}
            onChange={(e) => {
              void importBrowser([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          {toast.message ? (
            <div
              className="toast fixed bottom-11.5 left-[50%] [transform:translateX(-50%)] z-40 flex items-center gap-4.25 bg-surface-raised text-foreground border border-solid border-line-strong rounded-[12px] shadow-[0_5px_30px_#00000055] text-[12px] max-w-187.5 px-4.5 py-3.5"
              role="status"
            >
              <span>
                {toast.raw
                  ? toast.message
                  : translateMessage(
                      toast.message,
                      state.locale,
                      toast.values?.kind
                        ? { ...toast.values, kind: t(String(toast.values.kind)) }
                        : toast.values,
                    )}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={t('shell.dismissNotification')}
                onClick={() => setToast({ message: '' })}
              >
                <X size={16} />
              </button>
            </div>
          ) : null}
        </div>
      </LocaleContext.Provider>
    </ThemeContext.Provider>
  );
}
