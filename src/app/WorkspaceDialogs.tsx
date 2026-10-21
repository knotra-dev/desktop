import { ArrowRight, FolderOpen, Plus, Search, Settings2, Upload, Workflow } from 'lucide-react';
import type { RefObject } from 'react';
import { stringify } from 'yaml';
import { Modal, NodeIcon, nodeMeta } from '../components/ui';
import { TemplateLibrary } from '../features/pipelines/PipelinesView';
import { examples } from '../lib/examples';
import { useI18n } from '../lib/i18n';
import type { OpenedPackage } from '../lib/native';
import type { State } from '../lib/storage';
import type { NodeKind, Section, Workspace } from '../lib/types';
import { parsePipeline } from '../lib/validation';
import { navigation } from './WorkspaceShell';

export type WorkspaceDialog =
  | 'library'
  | 'node'
  | 'search'
  | 'delete'
  | 'import'
  | 'entrypoint'
  | 'engine-run'
  | 'restore'
  | undefined;

type DialogProps = { onClose: () => void };

export function RestoreWorkspaceDialog({
  restoring,
  onClose,
  onRestore,
}: DialogProps & { restoring: State; onRestore: () => void }) {
  const { t } = useI18n();
  return (
    <Modal
      title={t('shell.restoreWorkspaceBackup2')}
      subtitle={t('shell.reviewTheBackupBeforeReplacingYourLocalAuthoring')}
      onClose={onClose}
    >
      <div className="modal-body px-7.75 py-6.75">
        <p>
          {t('shell.draftsPipelineDraftsRunsDemoRunsThemeTheme', {
            drafts: restoring.workspaces.length,
            runs: restoring.runs.length,
            theme: t(restoring.theme === 'light' ? 'shell.light' : 'shell.dark'),
          })}
        </p>
        <p>{t('shell.yourCurrentDraftsAndDemoHistoryWillBe')}</p>
      </div>
      <div className="modal-footer flex items-center justify-between gap-4 bg-surface border-t border-solid border-t-line px-7.75 py-5">
        <button type="button" className="button" onClick={onClose}>
          {t('shell.keepCurrentWorkspace')}
        </button>
        <button type="button" className="button primary" onClick={onRestore}>
          {t('shell.restoreBackup')}
        </button>
      </div>
    </Modal>
  );
}

export function TemplateDialog({
  onClose,
  onSelect,
  onCreate,
}: DialogProps & { onSelect: (id: string) => void; onCreate: (opened: OpenedPackage) => void }) {
  const { t } = useI18n();
  return (
    <Modal
      title={t('library.title')}
      subtitle={t('shell.startWithATemplateThenConnectThePieces')}
      onClose={onClose}
      wide
    >
      <TemplateLibrary onSelect={onSelect} />
      <div className="modal-footer flex items-center justify-between gap-4 bg-surface border-t border-solid border-t-line px-7.75 py-5">
        <span>{t('library.footer')}</span>
        <button
          type="button"
          className="button"
          onClick={() => {
            const example = examples.find((e) => e.id === 'human');
            const pipeline = example && parsePipeline(example.source);
            if (!pipeline) return;
            const p = structuredClone(pipeline);
            p.metadata = {
              name: 'untitled-pipeline',
              title: t('pipelines.untitled'),
              description: t('pipelines.newDescription'),
            };
            onCreate({ source: stringify(p), entrypoint: 'pipeline.yaml', files: [] });
          }}
        >
          <Plus size={15} />
          {t('shell.startFromScratch')}
        </button>
      </div>
    </Modal>
  );
}

export function NodeDialog({ onClose, onAdd }: DialogProps & { onAdd: (kind: NodeKind) => void }) {
  const { t } = useI18n();
  return (
    <Modal
      title={t('shell.addANode')}
      subtitle={t('shell.chooseABlockSetItUpInThe')}
      onClose={onClose}
      wide
    >
      <div className="node-palette grid grid-cols-[repeat(2,_1fr)] gap-3.25 px-7.75 py-6.75">
        {Object.entries(nodeMeta).map(([kind, meta]) => (
          <button type="button" key={kind} onClick={() => onAdd(kind as NodeKind)}>
            <span className={`node-icon tint-${meta.color}`}>
              <NodeIcon kind={kind as NodeKind} />
            </span>
            <div>
              <strong>{t(meta.label)}</strong>
              <span>{t(meta.detail)}</span>
            </div>
            <Plus size={16} />
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function SearchDialog({
  onClose,
  workspaces,
  names,
  query,
  onQuery,
  onSelect,
  onNavigate,
}: DialogProps & {
  workspaces: Workspace[];
  names: Map<string, string>;
  query: string;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
  onNavigate: (section: Section) => void;
}) {
  const { t } = useI18n();
  return (
    <Modal title={t('shell.jumpToAnything')} onClose={onClose}>
      <div className="command-search flex gap-3 items-center border-b border-solid border-b-line text-secondary px-7.75 py-5.25">
        <Search size={19} />
        <input
          // biome-ignore lint/a11y/noAutofocus: The user opened search to type a query immediately.
          autoFocus
          aria-label={t('shell.searchWorkspace')}
          placeholder={t('shell.searchPipelinesOrViews')}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div className="command-results max-h-95 overflow-auto px-4 py-3.25">
        {workspaces
          .filter((w) => names.get(w.id)?.toLowerCase().includes(query.toLowerCase()))
          .map((w) => (
            <button type="button" key={w.id} onClick={() => onSelect(w.id)}>
              <Workflow size={17} />
              <span>{names.get(w.id)}</span>
              <small>{t('editor.pipeline')}</small>
            </button>
          ))}
        {[...navigation, { id: 'settings' as const, title: 'navigation.settings', icon: Settings2 }]
          .filter((n) => t(n.title).toLowerCase().includes(query.toLowerCase()))
          .map(({ id, title, icon: Icon }) => (
            <button
              type="button"
              key={id}
              onClick={() => {
                onNavigate(id);
                onClose();
              }}
            >
              <Icon size={17} />
              <span>{t(title)}</span>
              <small>{t('shell.view')}</small>
            </button>
          ))}
      </div>
      <div className="modal-footer flex items-center justify-between gap-4 bg-surface border-t border-solid border-t-line px-7.75 py-5">
        <span>
          {t('shell.ctrlKFind')}
          <span className="separator text-subtle mx-2 my-0">/</span>
          {t('shell.ctrlSSave')}
          <span className="separator text-subtle mx-2 my-0">/</span>
          {t('shell.ctrlNCreate')}
        </span>
      </div>
    </Modal>
  );
}

export function DeleteWorkspaceDialog({
  onClose,
  name,
  onDelete,
}: DialogProps & { name?: string; onDelete: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t('shell.removeThisPipeline')} onClose={onClose}>
      <div className="modal-body px-7.75 py-6.75">
        <p>
          {t('shell.thisRemoves')} <strong>{name ?? t('shell.thePipeline')}</strong>{' '}
          {t('shell.fromYourLocalWorkspaceExistingDemoRunsKeep')}
        </p>
      </div>
      <div className="modal-footer flex items-center justify-between gap-4 bg-surface border-t border-solid border-t-line px-7.75 py-5">
        <button type="button" className="button" onClick={onClose}>
          {t('shell.keepPipeline')}
        </button>
        <button type="button" className="button danger" onClick={onDelete}>
          {t('shell.removePipeline')}
        </button>
      </div>
    </Modal>
  );
}

export function PackageImportDialog({
  onClose,
  fileInput,
  folderInput,
}: DialogProps & {
  fileInput: RefObject<HTMLInputElement | null>;
  folderInput: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useI18n();
  return (
    <Modal
      title={t('shell.importAWorkflow')}
      subtitle={t('shell.openAnEntrypointYamlACompleteFolderOr')}
      onClose={onClose}
    >
      <div className="import-options grid grid-cols-[repeat(2,_1fr)] gap-4.75 px-7.75 py-6.75">
        <button type="button" onClick={() => fileInput.current?.click()}>
          <Upload size={25} />
          <strong>{t('shell.selectFilesOrZip')}</strong>
          <span>{t('shell.includeTheYamlAndDeclaredSupportingFiles')}</span>
        </button>
        <button type="button" onClick={() => folderInput.current?.click()}>
          <FolderOpen size={25} />
          <strong>{t('shell.selectPackageFolder')}</strong>
          <span>{t('shell.onlyDeclaredFilesAreAddedToTheWorkspace')}</span>
        </button>
      </div>
    </Modal>
  );
}

export function EntrypointDialog({
  onClose,
  entries,
  pickedEntry,
  onPick,
  onConfirm,
}: DialogProps & {
  entries: string[];
  pickedEntry: string;
  onPick: (entry: string) => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal
      title={t('shell.chooseTheEntrypoint')}
      subtitle={t('shell.thePackageContainsMoreThanOnePipelineDocument')}
      onClose={onClose}
    >
      <div className="modal-body px-7.75 py-6.75">
        <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
          {t('shell.entrypoint')}
          <select value={pickedEntry} onChange={(e) => onPick(e.target.value)}>
            {entries.map((path) => (
              <option key={path}>{path}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="modal-footer flex items-center justify-between gap-4 bg-surface border-t border-solid border-t-line px-7.75 py-5">
        <span>{t('shell.allFilePathsRemainRelativeToThePackage')}</span>
        <button type="button" className="button primary" onClick={onConfirm}>
          {t('common.openPackage')}
          <ArrowRight size={15} />
        </button>
      </div>
    </Modal>
  );
}
