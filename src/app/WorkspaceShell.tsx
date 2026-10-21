import {
  Bell,
  Cable,
  ChevronRight,
  FileBox,
  FolderOpen,
  History,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
  Workflow,
} from 'lucide-react';
import { type MessageKey, useI18n } from '../lib/i18n';
import { desktop } from '../lib/native';
import type { State } from '../lib/storage';
import type { Section, Workspace } from '../lib/types';

export const navigation: { id: Section; title: MessageKey; icon: typeof Workflow }[] = [
  { id: 'pipelines', title: 'navigation.pipelines', icon: Workflow },
  { id: 'runs', title: 'navigation.runs', icon: History },
  { id: 'inbox', title: 'navigation.inbox', icon: Inbox },
  { id: 'artifacts', title: 'navigation.artifacts', icon: FileBox },
  { id: 'connections', title: 'navigation.resources', icon: Cable },
];

type LocationProps = {
  section: Section;
  pipelinePage: 'list' | 'editor';
  workspace?: Workspace;
  names: Map<string, string>;
  navigate: (section: Section) => void;
};

export function WorkspaceSidebar({
  state,
  section,
  pipelinePage,
  workspace,
  names,
  waiting,
  engineConnected,
  navigate,
  selectWorkspace,
  onSearch,
  onCreate,
  onToggleNavigation,
}: LocationProps & {
  state: Pick<State, 'compact' | 'workspaces'>;
  waiting: number;
  engineConnected: boolean;
  selectWorkspace: (id: string) => void;
  onSearch: () => void;
  onCreate: () => void;
  onToggleNavigation: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className="app-sidebar w-54.5 shrink-0 flex flex-col bg-surface border-r border-solid border-line p-3.5">
      <div className="sidebar-brand-row flex items-center justify-between gap-2.5 pt-0 pr-1.25 pb-3.25 pl-3 min-h-11.75">
        <button
          type="button"
          className="brand flex items-center gap-2.5 pt-0 pb-6.5 w-full px-3"
          aria-label={t('shell.knotraWorkspace')}
          onClick={() => navigate('pipelines')}
        >
          <img src="/knotra.svg" alt="" />
          <span>knotra</span>
        </button>
        <button
          type="button"
          className="icon-button nav-toggle shrink-0 rounded-[6px] text-accent p-1.25"
          aria-label={t(state.compact ? 'shell.expandNavigation' : 'shell.collapseNavigation')}
          aria-expanded={!state.compact}
          title={t(state.compact ? 'shell.expandNavigation' : 'shell.collapseNavigation')}
          onClick={onToggleNavigation}
        >
          {state.compact ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
      <button
        type="button"
        className="sidebar-search flex items-center gap-2.25 text-[11px] text-muted mb-6 px-3 py-2.5"
        onClick={onSearch}
      >
        <Search size={16} />
        <span>{t('shell.findAnything')}</span>
        <kbd>⌘ K</kbd>
      </button>
      <nav aria-label={t('navigation.main')}>
        {navigation.map(({ id, title, icon: Icon }) => (
          <button
            type="button"
            key={id}
            data-tour={`nav-${id}`}
            aria-label={t(title)}
            aria-current={section === id ? 'page' : undefined}
            className={section === id ? 'active' : ''}
            onClick={() => navigate(id)}
            title={t(title)}
          >
            <Icon size={18} />
            <span>{t(title)}</span>
            {id === 'inbox' && waiting ? (
              <i className="nav-alert not-italic text-accent text-[10px] ml-auto bg-[rgb(var(--accent-rgb)_/_0.078)] rounded-[4px] px-1.25 py-0.5">
                {waiting}
              </i>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="sidebar-section flex items-center justify-between text-[9px] tracking-[1.3px] text-accent mt-7 mb-2.25 px-3 py-0 mx-0">
        <span>{t('shell.yourPipelines')}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={t('editor.createPipeline')}
          onClick={onCreate}
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="sidebar-pipelines overflow-auto max-h-[28vh]">
        {state.workspaces.map((w) => (
          <button
            type="button"
            className={
              workspace?.id === w.id && section === 'pipelines' && pipelinePage === 'editor'
                ? 'selected'
                : ''
            }
            key={w.id}
            onClick={() => selectWorkspace(w.id)}
            title={names.get(w.id)}
          >
            <span className="pipeline-dot w-1.5 h-1.5 border border-solid border-line-strong rounded-[2px] [transform:rotate(45deg)] shrink-0" />
            <span>{names.get(w.id)}</span>
            {w.source !== w.savedSource ? <i className="unsaved-dot" /> : null}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="sidebar-create flex items-center justify-center gap-2 mt-4.25 mb-0 text-[11px] text-accent border border-dashed border-line-strong rounded-[10px] p-3 mx-1"
        onClick={onCreate}
      >
        <Plus size={16} />
        <span>{t('shell.newPipeline')}</span>
      </button>
      <div className="sidebar-bottom mt-auto pt-6">
        <button
          type="button"
          className={section === 'settings' ? 'active' : ''}
          onClick={() => navigate('settings')}
          title={t('resources.workspaceSettings')}
        >
          <Settings2 size={18} />
          <span>{t('navigation.settings')}</span>
        </button>
        <div className="sidebar-environment flex items-center gap-2.25 pt-3.75 pb-0 mt-3.25 border-t border-solid border-t-line-strong text-[11px] text-accent px-3">
          <span className="dot green inline-block w-1.5 h-1.5 bg-surface-raised rounded-full shrink-0" />
          <span>
            {t('shell.localWorkspace')}
            <small>{t(engineConnected ? 'shell.engineConnected' : 'shell.offlineAuthoring')}</small>
          </span>
        </div>
      </div>
    </aside>
  );
}

export function WorkspaceHeader({
  section,
  pipelinePage,
  workspace,
  names,
  busy,
  waiting,
  navigate,
  openImport,
}: LocationProps & {
  busy: boolean;
  waiting: number;
  openImport: () => void;
}) {
  const { t } = useI18n();
  return (
    <header className="app-header h-15.25 shrink-0 flex items-center justify-between gap-5 border-b border-solid bg-surface border-line px-7.5 py-0">
      <div className="workspace-location flex items-center gap-2.75 text-accent text-[11px] min-w-0">
        <span>{t('shell.personalWorkspace')}</span>
        <ChevronRight size={13} />
        {section === 'pipelines' && pipelinePage === 'editor' ? (
          <>
            <button type="button" className="text-button" onClick={() => navigate('pipelines')}>
              {t('navigation.pipelines')}
            </button>
            <ChevronRight size={13} />
            <strong>{workspace ? names.get(workspace.id) : t('editor.pipelineDraft')}</strong>
          </>
        ) : (
          <strong>
            {t(navigation.find((item) => item.id === section)?.title ?? 'navigation.settings')}
          </strong>
        )}
      </div>
      <div className="header-actions flex items-center gap-4">
        <span className="runtime-label text-accent text-[9px]">
          {t(desktop ? 'resources.desktop' : 'shell.browserPreview')}
        </span>
        {section !== 'pipelines' || pipelinePage !== 'list' ? (
          <button type="button" className="button" disabled={busy} onClick={openImport}>
            <FolderOpen size={15} />
            <span>{t(busy ? 'shell.working' : 'common.openPackage')}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button notification-button relative"
          aria-label={
            waiting ? t('shell.countPendingReviews', { count: waiting }) : t('shell.reviewInbox')
          }
          onClick={() => navigate('inbox')}
        >
          <Bell size={18} />
          {waiting ? <i /> : null}
        </button>
      </div>
    </header>
  );
}
