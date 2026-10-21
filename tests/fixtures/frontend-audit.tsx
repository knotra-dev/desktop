import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SourceEditor from '../../src/components/editor/SourceEditor';
import { Modal } from '../../src/components/ui';
import { EngineArtifactsView } from '../../src/features/engine/EngineArtifactsView';
import { EngineInboxView } from '../../src/features/engine/EngineInboxView';
import WorkspaceView from '../../src/features/pipelines/WorkspaceView';
import { connectEngine } from '../../src/lib/engine/client';
import type { EngineRequest, EngineRun } from '../../src/lib/engine/types';
import type { EngineController } from '../../src/lib/engine/useEngine';
import { LocaleContext } from '../../src/lib/i18n';
import type { Workspace } from '../../src/lib/types';
import { validatePipeline } from '../../src/lib/validation';
import foreachSource from '../../vendor/engine/contracts/v1/fixtures/positive/foreach/pipeline.yaml?raw';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
const humanFields = params.has('fields');
const locale = params.get('locale') === 'ru' ? 'ru' : 'en';
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
const auditCommands: Parameters<EngineController['command']>[0][] = [];
Object.assign(window, { auditCommands });
const instanceId = (name: string) =>
  params.has('longIds') ? `n_${(name === 'first' ? 'a' : 'b').repeat(64)}` : `root/${name}`;
const engine: EngineController = {
  sessionKey: 'audit-fixture',
  info: {
    protocol: 'knotra.desktop/1',
    engineId: 'audit-engine',
    principalId: 'audit-user',
    version: 'fixture',
    capabilities: [],
  },
  connecting: false,
  syncing: false,
  error: '',
  runs: params.has('missingRuns')
    ? []
    : ['first', 'second'].map(
        (name): EngineRun => ({
          id: `run-${name}`,
          definitionId: 'definition-1',
          title: `Research ${name}`,
          status: 'running',
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
          profile: 'local',
          package: { entrypoint: 'pipeline.yaml', source: '', files: [] },
          inputs: {},
          inputArtifacts: {},
          outputs: {},
          artifacts: [],
          instances: [
            {
              id: instanceId(name),
              nodeId: `review_${name}`,
              scope: 'root',
              status: 'waiting_human',
            },
          ],
          diagnostics: [],
          availableActions: [],
        }),
      ),
  artifacts: [
    {
      id: 'artifact-1',
      name: 'hello.txt',
      mediaType: 'text/plain',
      size: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      origin: {},
    },
  ],
  profiles: [],
  resources: [],
  pending: [],
  requests: ['first', 'second'].map(
    (name): EngineRequest => ({
      id: params.has('longIds') ? `h_${name.repeat(16)}` : `request-${name}`,
      runId: `run-${name}`,
      instanceId: instanceId(name),
      attemptId: 'attempt-1',
      status: 'open',
      prompt: humanFields
        ? locale === 'ru'
          ? 'Прочитайте черновик и напишите ответ.'
          : 'Read the draft and write your response.'
        : `Review ${name} request.`,
      createdAt: '2026-10-01T00:00:00Z',
      deadline: '2030-01-01T00:00:00Z',
      inputs: {
        values: humanFields
          ? {
              draft:
                locale === 'ru'
                  ? 'Короткий черновик для проверки.'
                  : 'A short draft for your review.',
            }
          : {},
        artifacts:
          name === 'first'
            ? {
                document: {
                  id: 'artifact-1',
                  mediaType: 'text/plain',
                  size: 5,
                  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
                },
              }
            : {},
      },
      responseSchema: humanFields
        ? params.get('fields') === 'unicode'
          ? {
              type: 'object',
              required: ['constructor', 'answer'],
              properties: {
                constructor: { type: 'string', maxLength: 1 },
                answer: { type: 'string', minLength: 2, maxLength: 2 },
              },
              additionalProperties: false,
            }
          : {
              type: 'object',
              required: ['answer', 'approved'],
              properties: {
                answer: { type: 'string', minLength: 1 },
                approved: { type: 'boolean' },
                feedback: { type: 'string' },
              },
              additionalProperties: false,
            }
        : { type: 'object' },
    }),
  ),
  connect: async () => undefined,
  disconnect: async () => {},
  refresh: async () => {},
  command: async <T,>(request: Parameters<EngineController['command']>[0]) => {
    auditCommands.push(request);
    if (request.op === 'upload') throw new Error('Upload failed in fixture.');
    return { accepted: true } as T;
  },
};

function Fixture() {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [inboxOpen, setInboxOpen] = useState(true);
  const [responseDrafts, setResponseDrafts] = useState<Record<string, string>>({});
  const [workspace, setWorkspace] = useState<Workspace>({
    id: 'audit-workspace',
    entrypoint: 'pipeline.yaml',
    source: foreachSource,
    savedSource: foreachSource,
    files: [],
    updatedAt: '2026-10-01T00:00:00Z',
  });
  switch (new URLSearchParams(location.search).get('component')) {
    case 'inbox':
      return inboxOpen ? (
        <EngineInboxView
          engine={engine}
          onRun={() => setInboxOpen(false)}
          responseDrafts={responseDrafts}
          onResponseDraftsChange={setResponseDrafts}
        />
      ) : (
        <button type="button" onClick={() => setInboxOpen(true)}>
          Return to inbox
        </button>
      );
    case 'artifacts':
      return <EngineArtifactsView engine={engine} />;
    case 'snapshot':
      return <SourceEditor source={'name: immutable-run\nvalue: original\n'} readOnly />;
    case 'workspace':
      return (
        <WorkspaceView
          workspace={workspace}
          validation={validatePipeline(workspace.source, [], workspace.entrypoint)}
          onChange={(source, files, positions) =>
            setWorkspace((current) => ({
              ...current,
              source,
              files: files ?? current.files,
              positions: positions ?? current.positions,
            }))
          }
          onSave={() => {}}
          onExport={() => {}}
          onLibrary={() => {}}
          onAddNode={() => {}}
          onDelete={() => {}}
          onNotify={() => {}}
          engineConnected={false}
          onEngineRun={() => {}}
        />
      );
    default:
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open resolution
          </button>
          {open ? (
            <Modal title="Resolve unknown outcome" onClose={() => setOpen(false)}>
              <label>
                Resolution evidence
                <textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} />
              </label>
            </Modal>
          ) : null}
        </>
      );
  }
}

if (
  new URLSearchParams(location.search).get('component') === 'artifacts' ||
  new URLSearchParams(location.search).has('connected')
)
  await connectEngine('http://127.0.0.1:19879');
createRoot(document.getElementById('root')!).render(
  <LocaleContext.Provider value={locale}>
    <Fixture />
  </LocaleContext.Provider>,
);
