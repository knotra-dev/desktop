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
import { flushSync } from 'react-dom';
import { parseDocument } from 'yaml';
import { nodeMeta } from '../components/ui';
import { EngineArtifactsView } from '../features/engine/EngineArtifactsView';
import { EngineBanner } from '../features/engine/EngineBanner';
import { EngineInboxView } from '../features/engine/EngineInboxView';
import { EngineRunDialog } from '../features/engine/EngineRunDialog';
import { EngineRunsView } from '../features/engine/EngineRunsView';
import { WorkspaceTour } from '../features/onboarding/WorkspaceTour';
import { PipelinesView } from '../features/pipelines/PipelinesView';
import { ConnectionsView, SettingsView } from '../features/resources/ResourceViews';
import {
  applyPipelineControl,
  controlEditorBusy,
  controlWorkspace,
  DesktopControlError,
  rollbackControlChange,
} from '../lib/desktopControl';
import { downloadArtifact } from '../lib/engine/client';
import { enginePackage } from '../lib/engine/package';
import type { EngineCall } from '../lib/engine/types';
import { useEngine } from '../lib/engine/useEngine';
import { examples, fromExample } from '../lib/examples';
import {
  LocaleContext,
  type TranslationValues,
  translateMessage,
  useTranslation,
} from '../lib/i18n';
import { desktop, exportFile, type OpenedPackage } from '../lib/native';
import { createLearningWorkspace } from '../lib/onboarding';
import { allowedFiles } from '../lib/package';
import {
  cancelSetup,
  type SavedConnection,
  type SavedMcpConnection,
  type SetupStatus,
  savedConnections,
  savedMcpConnections,
  setupStatus,
  startDesktopEngine,
} from '../lib/setup';
import {
  flushWorkspace,
  readBackup,
  STARTER_REVISION,
  type State,
  saveState,
} from '../lib/storage';
import { ThemeContext } from '../lib/theme';
import { type NodeKind, record, type Section, type Workspace } from '../lib/types';
import { parsePipeline, validatePipeline } from '../lib/validation';
import { useDesktopControl } from './useDesktopControl';
import { usePackageTransfer } from './usePackageTransfer';
import { useWorkspacePersistence, useWorkspaceShortcuts } from './useWorkspaceEffects';
import {
  DeleteWorkspaceDialog,
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
  const [openResourceNode, setOpenResourceNode] = useState<{
    path: string;
    kind: 'models' | 'mcp' | 'sandboxes' | 'secrets';
  }>();
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
  const [tourIndex, setTourIndex] = useState<number | undefined>(() => {
    try {
      return localStorage.getItem('knotra.tour.v1') === 'dismissed' ? undefined : 0;
    } catch {
      return 0;
    }
  });
  const [tourWorkspaceId, setTourWorkspaceId] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem('knotra.tour.workspace.v1') ?? undefined;
    } catch {
      return undefined;
    }
  });
  const rememberedLesson = state.workspaces.find((w) => w.id === tourWorkspaceId);
  const lessonPipeline = rememberedLesson ? parsePipeline(rememberedLesson.source) : undefined;
  const lessonModel = lessonPipeline?.spec.nodes.answer;
  const lessonAlias = record(lessonModel?.llm).model;
  const learningWorkspace =
    lessonModel?.type === 'llm' &&
    typeof lessonAlias === 'string' &&
    lessonModel.outputs?.text &&
    lessonPipeline?.spec.models?.[lessonAlias]
      ? rememberedLesson
      : undefined;
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
  }, [section, pipelinePage, workspace?.id, activeRun]);
  const engine = useEngine(notifyRaw);
  const [modelConnections, setModelConnections] = useState<SavedConnection[]>([]);
  const [mcpConnections, setMcpConnections] = useState<SavedMcpConnection[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<SetupStatus>();
  const ownEngineConnected =
    desktop &&
    state.engineMode !== 'manual' &&
    runtimeStatus?.phase === 'ready' &&
    runtimeStatus.endpoint === state.engineUrl;
  const engineIntent = useRef(state.engineMode ?? 'local');
  const attachOnOpen = useRef(engineIntent.current === 'local');
  const localGeneration = useRef<number | undefined>(undefined);
  const setupAttachment = useRef<{ endpoint: string; promise: Promise<void> } | undefined>(
    undefined,
  );
  const setupReady = useCallback(
    async (endpoint: string) => {
      if (engineIntent.current !== 'local') return;
      if (setupAttachment.current?.endpoint === endpoint) return setupAttachment.current.promise;
      const promise = (async () => {
        const connected = await engine.connect(endpoint);
        if (engineIntent.current !== 'local') return;
        if (!connected) throw new Error(t('modelSetup.connectFailed'));
        attachOnOpen.current = false;
        setState((current) => ({ ...current, engineUrl: endpoint, engineMode: 'local' }));
      })();
      setupAttachment.current = { endpoint, promise };
      try {
        await promise;
      } finally {
        if (setupAttachment.current?.promise === promise) setupAttachment.current = undefined;
      }
    },
    [engine.connect, t],
  );
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let revision = 0;
    async function load() {
      const current = ++revision;
      const results = await Promise.allSettled([savedConnections(), savedMcpConnections()]);
      if (!active || current !== revision) return;
      const [models, mcp] = results;
      if (models.status === 'fulfilled' && Array.isArray(models.value))
        setModelConnections(models.value);
      else if (models.status === 'rejected') notifyRaw(String(models.reason));
      if (mcp.status === 'fulfilled' && Array.isArray(mcp.value)) setMcpConnections(mcp.value);
      else if (mcp.status === 'rejected') notifyRaw(String(mcp.reason));
    }
    void load();
    window.addEventListener('knotra-connections-changed', load);
    return () => {
      active = false;
      window.removeEventListener('knotra-connections-changed', load);
    };
  }, [notifyRaw]);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      clearTimeout(timer);
      let delay = 5000;
      try {
        const status = await setupStatus();
        if (!active) return;
        setRuntimeStatus(status);
        delay =
          status.phase === 'starting' ||
          status.sourcesState === 'pending' ||
          status.sourcesState === 'applying'
            ? 1000
            : 5000;
        if (status.phase === 'ready' && status.engineGeneration !== undefined) {
          const changed =
            localGeneration.current !== undefined &&
            localGeneration.current !== status.engineGeneration;
          localGeneration.current = status.engineGeneration;
          if (changed && engineIntent.current === 'local' && !attachOnOpen.current)
            await engine.refresh();
        }
        if (
          status.configured &&
          status.phase === 'ready' &&
          status.endpoint &&
          attachOnOpen.current
        )
          await setupReady(status.endpoint);
      } catch (error) {
        if (active) notifyRaw(String(error));
      } finally {
        polling = false;
        if (active) timer = setTimeout(poll, delay);
      }
    }
    void poll();
    window.addEventListener('knotra-engine-changed', poll);
    window.addEventListener('knotra-connections-changed', poll);
    function startRequested() {
      engineIntent.current = 'local';
      attachOnOpen.current = true;
      setState((current) => ({ ...current, engineMode: 'local' }));
      void poll();
    }
    window.addEventListener('knotra-engine-start-requested', startRequested);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener('knotra-engine-changed', poll);
      window.removeEventListener('knotra-connections-changed', poll);
      window.removeEventListener('knotra-engine-start-requested', startRequested);
    };
  }, [notifyRaw, setupReady, engine.refresh]);
  async function setupStopped(endpoint: string | undefined) {
    attachOnOpen.current = false;
    if (endpoint && endpoint === state.engineUrl) await engine.disconnect();
  }
  const currentReviewScope = engine.sessionKey ?? 'offline';
  const waiting = engine.info
    ? engine.requests.filter((request) => request.status === 'open').length
    : 0;
  const stateRef = useWorkspacePersistence(state, notify);
  const controlBusy = useRef({ dialog, busy });
  controlBusy.current = { dialog, busy };
  useDesktopControl(async (operation, args) => {
    function requireIdle(target?: string, navigating = false) {
      const field = document.activeElement;
      const editingForm =
        field instanceof HTMLElement && field.matches('input, textarea, [contenteditable="true"]');
      if (
        controlBusy.current.dialog ||
        controlBusy.current.busy ||
        (navigating && editingForm) ||
        (target === stateRef.current.activeId && controlEditorBusy())
      )
        throw new DesktopControlError(
          'busy',
          'Finish editing the focused field or close the current dialog before changing this pipeline or view.',
        );
    }
    async function commit(next: State) {
      const previous = stateRef.current;
      flushSync(() => setState(next));
      try {
        await saveState(next);
        await flushWorkspace();
      } catch {
        const recovered = rollbackControlChange(previous, next, stateRef.current);
        flushSync(() => setState(recovered));
        await saveState(recovered).catch(() => {});
        throw new DesktopControlError(
          'storage',
          'Could not persist the change. Read the pipeline again before retrying.',
        );
      }
    }
    if (operation === 'app_status')
      return {
        section,
        pipelinePage,
        workspaceId: stateRef.current.activeId,
        runId: activeRun,
        engine: engine.info ?? null,
      };
    if (operation === 'app_navigate') {
      requireIdle(undefined, true);
      if (
        !['pipelines', 'runs', 'inbox', 'artifacts', 'connections', 'settings'].includes(
          String(args.section),
        )
      )
        throw new DesktopControlError('invalid', 'Choose a valid Knotra section.');
      if (args.runId !== undefined && typeof args.runId !== 'string')
        throw new DesktopControlError('invalid', 'Run ID must be text.');
      if (args.workspaceId !== undefined) {
        if (!stateRef.current.workspaces.some((workspace) => workspace.id === args.workspaceId))
          throw new DesktopControlError('not_found', 'Pipeline not found.');
        await commit({ ...stateRef.current, activeId: String(args.workspaceId) });
      }
      flushSync(() => {
        navigate(args.section as Section);
        if (args.section === 'pipelines' && args.workspaceId) setPipelinePage('editor');
        if (args.section === 'runs' && args.runId) setActiveRun(args.runId as string);
      });
      return { section: args.section, workspaceId: stateRef.current.activeId, runId: args.runId };
    }
    if (operation === 'pipeline_publish') {
      requireIdle(String(args.id ?? ''));
      const target = await controlWorkspace(stateRef.current, args, true);
      if (typeof args.operationId !== 'string' || !args.operationId)
        throw new DesktopControlError(
          'invalid',
          'Provide an operationId and reuse it if the publish result is unknown.',
        );
      return engine.command({
        op: 'publish',
        package: enginePackage(target),
        operationId: args.operationId,
      });
    }
    if (operation.startsWith('pipeline_')) {
      const base = stateRef.current;
      const mutating = ['pipeline_create', 'pipeline_update', 'pipeline_delete'].includes(
        operation,
      );
      if (mutating)
        requireIdle(
          String(args.id ?? ''),
          args.activate !== false && operation !== 'pipeline_delete',
        );
      const applied = await applyPipelineControl(base, operation, args);
      if (applied.state) {
        requireIdle(String(args.id ?? ''), !!applied.activate);
        if (stateRef.current !== base)
          throw new DesktopControlError(
            'conflict',
            'The workspace changed while preparing this edit. Read the pipeline again and retry.',
          );
        await commit(applied.state);
        if (applied.activate)
          flushSync(() => {
            setOpenResources(undefined);
            setOpenResourceNode(undefined);
            setSection('pipelines');
            setPipelinePage('editor');
          });
      }
      return applied.result;
    }
    if (operation === 'engine_status')
      return {
        status: await setupStatus(),
        connected: engine.info ?? null,
        pending: engine.pending,
      };
    if (operation === 'engine_start') {
      window.dispatchEvent(new Event('knotra-engine-start-requested'));
      const status = await startDesktopEngine();
      window.dispatchEvent(new Event('knotra-engine-changed'));
      return { status };
    }
    if (operation === 'engine_stop') {
      const before = await setupStatus();
      const status = await cancelSetup();
      await setupStopped(before.endpoint);
      window.dispatchEvent(new Event('knotra-engine-changed'));
      return { status };
    }
    if (operation === 'engine_connect') {
      if (
        typeof args.url !== 'string' ||
        (args.token !== undefined && typeof args.token !== 'string')
      )
        throw new DesktopControlError(
          'invalid',
          'Provide an engine URL and an optional access token.',
        );
      engineIntent.current = 'manual';
      attachOnOpen.current = false;
      const info = await engine.connect(args.url, args.token as string | undefined);
      if (!info)
        throw new Error('Could not connect to the engine. Check its address and credentials.');
      await commit({ ...stateRef.current, engineUrl: args.url, engineMode: 'manual' });
      return { info };
    }
    if (operation === 'engine_disconnect') {
      engineIntent.current = 'manual';
      attachOnOpen.current = false;
      await engine.disconnect();
      await commit({ ...stateRef.current, engineMode: 'manual' });
      return { disconnected: true };
    }
    if (operation === 'engine_call') return engine.command(args as unknown as EngineCall);
    if (operation === 'artifact_download') {
      if (typeof args.artifactId !== 'string' || !args.artifactId)
        throw new DesktopControlError('invalid', 'Provide an artifact ID from the engine.');
      return downloadArtifact(args.artifactId);
    }
    throw new DesktopControlError('invalid', 'Unsupported desktop control operation.');
  });
  useEffect(() => {
    if (!toast.message) return;
    const timer = setTimeout(() => setToast({ message: '' }), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
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
    if (tourIndex !== undefined && id !== tourWorkspaceId) setTourIndex(0);
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
    if (tourIndex !== undefined) setTourIndex(0);
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
    if (tourIndex !== undefined) setTourIndex(0);
    closeDialog();
  }
  function addNode(kind: NodeKind) {
    if (!workspace || !validation.pipeline) return;
    const example = examples.find((e) => e.id === (kind === 'pipeline' ? 'subpipeline' : kind));
    if (!example) return;
    const p = parsePipeline(example.source);
    if (!p) return;
    const node = structuredClone(Object.values(p.spec.nodes)[0]);
    if (kind === 'tool') {
      node.tool = { ...record(node.tool), response: 'content' };
      node.outputs = { result: { schema: { type: 'array', items: { type: 'object' } } } };
    }
    if (kind === 'human' && workspace.id === tourWorkspaceId && tourIndex === 2) {
      node.inputs = { draft: { schema: { type: 'string' }, bind: { value: '' } } };
      node.human = { prompt: { text: t('tour.pipeline.reviewPrompt') } };
    }

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
    if (kind === 'human' && workspace.id === tourWorkspaceId && tourIndex === 2) setTourIndex(3);
    notify('messages.kindNodeAddedChooseItsModelOrTool', {
      kind: nodeMeta[kind].label,
    });
  }
  function navigate(next: Section) {
    setOpenResources(undefined);
    setOpenResourceNode(undefined);
    setSection(next);
    if (next === 'pipelines') setPipelinePage('list');
    if (next === 'runs') setActiveRun(undefined);
    if (tourIndex !== undefined) {
      if (next === 'connections') setTourIndex(4);
      else if (next === 'settings') setTourIndex(desktop ? 4 : 6);
      else if (next === 'inbox' || next === 'runs' || next === 'artifacts') setTourIndex(7);
      else setTourIndex(0);
    }
  }
  function openEngineSettings() {
    navigate('settings');
    if (tourIndex !== undefined) setTourIndex(6);
    requestAnimationFrame(() => {
      document
        .querySelector(desktop ? '[data-tour="local-engine"]' : '[data-tour="engine"]')
        ?.scrollIntoView({ block: 'start' });
    });
  }
  const tourSteps = [
    { id: 'welcome', section: 'pipelines', target: '[data-tour="nav-pipelines"]' },
    { id: 'prompt', section: 'pipelines', target: '.setup-inspector textarea' },
    { id: 'add', section: 'pipelines', target: '[data-tour="add-node"]' },
    { id: 'connect', section: 'pipelines', target: '.graph-view' },
    {
      id: 'models',
      section: 'settings',
      target: section === 'connections' ? '[data-tour="nav-settings"]' : '.model-setup',
    },
    { id: 'binding', section: 'pipelines', target: '[data-tour="node-model"]' },
    { id: 'run', section: 'pipelines', target: '[data-tour="run"], [data-tour="engine"]' },
    { id: 'review', section: 'inbox', target: '[data-tour="nav-inbox"]' },
  ] satisfies { id: string; section: Section; target: string }[];
  const reviewNode = Object.entries(validation.pipeline?.spec.nodes ?? {}).find(
    ([, node]) => node.type === 'human',
  );
  const reviewConnected =
    validation.pipeline?.spec.nodes.answer?.type === 'llm' &&
    !!validation.pipeline.spec.nodes.answer.outputs?.text &&
    Object.values(reviewNode?.[1].inputs ?? {}).some(
      (port) => port.bind?.from === 'nodes.answer.outputs.text',
    );
  function startLearningPipeline() {
    const lesson = learningWorkspace ?? createLearningWorkspace(state.locale);
    if (!learningWorkspace) {
      setState((s) => ({ ...s, workspaces: [...s.workspaces, lesson], activeId: lesson.id }));
      setTourWorkspaceId(lesson.id);
      try {
        localStorage.setItem('knotra.tour.workspace.v1', lesson.id);
      } catch {
        notify('tour.storageUnavailable');
      }
    } else setState((s) => ({ ...s, activeId: lesson.id }));
    setSection('pipelines');
    setPipelinePage('editor');
    setOpenResources(undefined);
    setTourIndex(1);
  }
  function showTourStep(index: number) {
    if ([1, 2, 3, 5, 6].includes(index) && !learningWorkspace) {
      showTourStep(0);
      return;
    }
    closeDialog();
    navigate(tourSteps[index].section);
    if ([1, 2, 3, 5, 6].includes(index) && learningWorkspace) {
      setState((s) => ({ ...s, activeId: learningWorkspace.id }));
      setPipelinePage('editor');
      if (index === 5) setOpenResources(undefined);
    }
    setTourIndex(index);
  }
  function nextTourStep() {
    if (tourIndex === undefined) return;
    if (tourIndex === 0) startLearningPipeline();
    else if (tourIndex === 2 && !reviewNode) {
      setAddScope([]);
      setDialog('node');
    } else if (tourIndex === tourSteps.length - 1) closeTour();
    else showTourStep(tourIndex + 1);
  }
  function closeTour() {
    setTourIndex(undefined);
    try {
      localStorage.setItem('knotra.tour.v1', 'dismissed');
    } catch {
      notify('tour.storageUnavailable');
    }
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
      setRestoring(undefined);
      closeDialog();
      notify('messages.workspaceBackupRestored');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }
  const inlineTour = tourIndex === 7 && section === 'inbox';
  const tourGuide =
    tourIndex !== undefined && !dialog ? (
      <WorkspaceTour
        step={{
          ...tourSteps[tourIndex],
          title: t(`tour.${tourSteps[tourIndex].id}.title`),
          description: t(
            tourIndex === 0 && rememberedLesson && !learningWorkspace
              ? 'tour.rebuildLesson'
              : `tour.${tourSteps[tourIndex].id}.description`,
          ),
        }}
        index={tourIndex}
        total={tourSteps.length}
        inline={inlineTour}
        nextLabel={
          tourIndex === 2
            ? t('tour.chooseReview')
            : tourIndex === 0
              ? t(learningWorkspace ? 'tour.continueLesson' : 'tour.createLesson')
              : undefined
        }
        side={[1, 3, 5, 7].includes(tourIndex) ? 'left' : 'right'}
        nextDisabled={tourIndex === 3 && !reviewConnected}
        onSkipStep={tourIndex === 4 ? () => showTourStep(5) : undefined}
        skipStepLabel={tourIndex === 4 ? t('tour.skipModels') : undefined}
        onBack={() => showTourStep(tourIndex - 1)}
        onNext={nextTourStep}
        onClose={closeTour}
      />
    ) : null;
  return (
    <ThemeContext.Provider value={state.theme}>
      <LocaleContext.Provider value={state.locale}>
        <div
          className={`app-shell flex h-dvh min-h-160 min-w-245 overflow-hidden bg-base ${state.compact ? 'compact' : ''} ${tourIndex === 4 ? '[&_.model-setup]:mr-[434px]!' : ''}`}
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
              {['runs', 'inbox', 'artifacts'].includes(section) ||
              (desktop && section === 'pipelines' && pipelinePage === 'list' && !engine.info) ||
              (state.engineMode !== 'manual' &&
                runtimeStatus?.sourcesState &&
                runtimeStatus.sourcesState !== 'current') ? (
                <EngineBanner
                  engine={engine}
                  runtimeStatus={state.engineMode === 'manual' ? undefined : runtimeStatus}
                  onSettings={openEngineSettings}
                />
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
                    nodeRequested={
                      openResourceNode?.path ??
                      (workspace?.id === tourWorkspaceId && tourIndex !== undefined
                        ? tourIndex === 1 || tourIndex === 5 || tourIndex === 6
                          ? 'answer'
                          : tourIndex === 3
                            ? reviewNode?.[0]
                            : undefined
                        : undefined)
                    }
                    key={workspace?.id ?? 'empty'}
                    nodeResourceRequested={openResourceNode?.kind}
                    workspace={workspace}
                    validation={validation}
                    engineConnected={!!engine.info && !engine.error}
                    engineResources={engine.resources}
                    modelConnections={modelConnections}
                    mcpConnections={state.engineMode === 'manual' ? [] : mcpConnections}
                    onConnectMcp={() => {
                      navigate('settings');
                      requestAnimationFrame(() => {
                        const section = document.getElementById('mcp-settings');
                        section?.scrollIntoView({ block: 'start' });
                        section?.querySelector<HTMLButtonElement>('[data-add-mcp]')?.focus();
                      });
                    }}
                    onConnectModels={() => navigate('settings')}
                    onConnectSandboxes={openEngineSettings}
                    onEngineRun={() => {
                      if (
                        engine.info &&
                        !engine.error &&
                        !(
                          state.engineMode !== 'manual' &&
                          runtimeStatus?.sourcesState === 'applying'
                        )
                      )
                        setDialog('engine-run');
                      else openEngineSettings();
                    }}
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
                    onLibrary={() => setDialog('library')}
                    onAddNode={(scope) => {
                      setAddScope(scope);
                      setDialog('node');
                    }}
                    onDelete={() => setDialog('delete')}
                    onNotify={notify}
                  />
                </Suspense>
              ) : section === 'runs' ? (
                <EngineRunsView
                  engine={engine}
                  activeId={activeRun}
                  onSelect={setActiveRun}
                  onReview={() => navigate('inbox')}
                />
              ) : section === 'inbox' ? (
                <EngineInboxView
                  tour={inlineTour ? tourGuide : undefined}
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
                    if (tourIndex !== undefined) setTourIndex(7);
                  }}
                />
              ) : section === 'artifacts' ? (
                <EngineArtifactsView engine={engine} />
              ) : section === 'connections' ? (
                <ConnectionsView
                  tour={inlineTour ? tourGuide : undefined}
                  engine={engine}
                  modelConnections={
                    ownEngineConnected || (!engine.info && state.engineMode !== 'manual')
                      ? modelConnections
                      : undefined
                  }
                  mcpConnections={
                    ownEngineConnected || (!engine.info && state.engineMode !== 'manual')
                      ? mcpConnections
                      : undefined
                  }
                  pipeline={validation.pipeline}
                  onManage={(kind) => {
                    if (kind === 'sandboxes' || kind === 'secrets') openEngineSettings();
                    else {
                      navigate('settings');
                      requestAnimationFrame(() =>
                        document
                          .querySelector(kind === 'models' ? '.model-setup' : '#mcp-settings')
                          ?.scrollIntoView({ block: 'start' }),
                      );
                    }
                  }}
                  onEditNode={(path, kind) => {
                    navigate('pipelines');
                    setOpenResourceNode(path.length ? { path: path.join('/'), kind } : undefined);
                    setPipelinePage('editor');
                  }}
                  onSource={(kind) => {
                    setOpenResources(kind);
                    setSection('pipelines');
                    setPipelinePage('editor');
                    if (tourIndex !== undefined) setTourIndex(kind === 'models' ? 5 : 6);
                  }}
                />
              ) : (
                <SettingsView
                  tour={inlineTour ? tourGuide : undefined}
                  onRestore={() => backupInput.current?.click()}
                  onStartTour={() => showTourStep(0)}
                  engine={engine}
                  onSetupReady={setupReady}
                  onSetupStopped={setupStopped}
                  onManualEngineAction={(engineUrl) => {
                    engineIntent.current = 'manual';
                    attachOnOpen.current = false;
                    setState((current) => ({
                      ...current,
                      engineMode: 'manual',
                      ...(engineUrl ? { engineUrl } : {}),
                    }));
                  }}
                  engineUrl={state.engineUrl}
                  engineMode={state.engineMode}
                  desktop={desktop}
                  theme={state.theme}
                  language={state.locale}
                  onLanguage={(locale) => setState((s) => ({ ...s, locale }))}
                  onTheme={(theme) => setState((s) => ({ ...s, theme }))}
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
                setSection('runs');
                if (tourIndex !== undefined) setTourIndex(7);
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
          {!inlineTour ? tourGuide : null}
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
