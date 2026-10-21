import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { stringify } from 'yaml';
import type { EngineCall } from '../../src/lib/engine/types';
import type { SavedConnection, SetupStatus } from '../../src/lib/setup';
import type { State } from '../../src/lib/storage';
import type { Workspace } from '../../src/lib/types';

type ControlReply = { result?: unknown; error?: { code: string; message: string } };
type ControlFixture = {
  controlRequest: (operation: string, args?: Record<string, unknown>) => Promise<ControlReply>;
  controlChange: (payload: Record<string, unknown>) => void;
  controlSources: (sources: SavedConnection[]) => void;
  controlFailSave: (source: string) => void;
  controlSourceStatus: (status: Partial<SetupStatus>) => void;
  controlListeners: string[];
  controlCalls: { command: string; args: Record<string, unknown> }[];
};

function source(title = 'Controlled pipeline') {
  return stringify({
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: { name: 'controlled-pipeline', title },
    spec: {
      nodes: {
        review: {
          type: 'human',
          human: { prompt: { text: 'Review this request.' } },
          outputs: { approved: { schema: { type: 'boolean' } } },
        },
      },
      outputs: {
        approved: {
          schema: { type: 'boolean' },
          bind: { from: 'nodes.review.outputs.approved' },
        },
      },
    },
  });
}

function workspace(id = 'existing', title = 'Existing pipeline'): Workspace {
  const yaml = source(title);
  return {
    id,
    source: yaml,
    savedSource: yaml,
    entrypoint: 'pipeline.yaml',
    files: [{ path: 'notes.txt', content: 'a2VlcCBtZQ==' }],
    positions: { review: { x: 120, y: 240 } },
    updatedAt: '2026-10-21T00:00:00Z',
  };
}

async function open(
  page: Page,
  workspaces: Workspace[] = [],
  options: { locale?: 'en' | 'ru'; theme?: 'dark' | 'light'; sources?: SavedConnection[] } = {},
) {
  const initial: State = {
    version: 1,
    starterRevision: 5,
    runs: [],
    engineUrl: 'http://127.0.0.1:8787',
    engineMode: 'local',
    compact: false,
    theme: options.theme ?? 'dark',
    locale: options.locale ?? 'en',
    workspaces,
    activeId: workspaces[0]?.id ?? '',
  };
  await page.addInitScript(
    (initialText) => {
      const { initial, sources: initialSources } = JSON.parse(initialText);
      const target = window as unknown as ControlFixture;
      let sequence = 0;
      const callbacks = new Map<number, (value: unknown) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      const pending = new Map<string, (reply: ControlReply) => void>();
      let sources: SavedConnection[] = initialSources;
      let failSave: string | undefined;
      let runStarted = false;
      let responded = false;
      let sourceStatus: Partial<SetupStatus> = { sourcePhase: 'idle' };
      target.controlListeners = [];
      target.controlCalls = [];
      const engineInfo = {
        protocol: 'knotra.desktop/1',
        engineId: 'control-engine',
        principalId: 'operator',
        version: 'fixture',
        capabilities: [
          'definitions',
          'runs',
          'requests',
          'artifacts',
          'events',
          'history',
          'resolution',
        ],
      };

      function engineRun() {
        const source = initial.workspaces[0]?.source ?? '# Immutable run package';
        return {
          id: 'control-run',
          definitionId: 'control-definition',
          title: 'Started through MCP',
          status: responded ? 'succeeded' : 'waiting_human',
          createdAt: '2026-10-21T00:00:00Z',
          updatedAt: '2026-10-21T00:00:00Z',
          profile: 'local',
          package: {
            entrypoint: 'pipeline.yaml',
            source,
            files: [{ path: 'pipeline.yaml', content: btoa(source) }],
          },
          inputs: {},
          inputArtifacts: {},
          outputs: {},
          artifacts: [],
          instances: [],
          diagnostics: [],
          availableActions: responded ? [] : ['cancel'],
        };
      }

      function emit(event: string, payload: unknown) {
        for (const [id, listener] of listeners)
          if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
      }
      target.controlRequest = (operation, args = {}) => {
        const id = `fixture-${++sequence}`;
        const reply = new Promise<ControlReply>((resolve) => pending.set(id, resolve));
        emit('knotra-control-request', { id, operation, arguments: args });
        return reply;
      };
      target.controlChange = (payload) => emit('knotra-control-changed', payload);
      target.controlSources = (next) => {
        sources = next;
      };
      target.controlFailSave = (source) => {
        failSave = source;
      };
      target.controlSourceStatus = (next) => {
        sourceStatus = next;
      };
      Object.assign(window, {
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener: (_event: string, id: number) => listeners.delete(id),
        },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: 'main' } },
          transformCallback: (callback: (value: unknown) => void) => {
            const id = ++sequence;
            callbacks.set(id, callback);
            return id;
          },
          unregisterCallback: (id: number) => callbacks.delete(id),
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            target.controlCalls.push({ command, args });
            if (command === 'plugin:event|listen') {
              const id = ++sequence;
              listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
              target.controlListeners = [...listeners.values()].map((item) => item.event);
              return id;
            }
            if (command === 'plugin:event|unlisten') {
              listeners.delete(Number(args.eventId));
              return;
            }
            if (command === 'workspace_load')
              return JSON.parse(
                sessionStorage.getItem('control.workspace') ?? JSON.stringify(initial),
              );
            if (command === 'workspace_save') {
              if (failSave && JSON.stringify(args.value).includes(failSave)) {
                throw new Error('Fixture storage unavailable');
              }

              sessionStorage.setItem('control.workspace', JSON.stringify(args.value));
              return;
            }
            if (command === 'desktop_control_reply') {
              pending.get(String(args.id))?.({
                result: args.result,
                error: args.error as ControlReply['error'],
              });
              pending.delete(String(args.id));
              return;
            }
            if (command === 'desktop_control_status')
              return {
                protocol: 'knotra.desktop-control/1',
                available: true,
                frontendReady: true,
                config: {
                  mcpServers: {
                    knotra: {
                      command: '/Applications/Knotra.app/Contents/Resources/runtime/knotra',
                      args: [
                        'mcp',
                        'serve',
                        '--desktop',
                        '--bridge-file',
                        '/Users/example/Library/Application Support/app.knotra/control.json',
                      ],
                    },
                  },
                },
              };
            if (command === 'desktop_setup_status')
              return {
                phase: 'idle',
                configured: false,
                connections: sources,
                mcpConnections: [],
                sourcePhase: 'idle',
                sourcesState: 'current',
                runtimeAvailable: true,
                dockerReady: true,
                codexAvailable: true,
                claudeAvailable: true,
                ...sourceStatus,
              };
            if (command === 'desktop_connections_list') return sources;
            if (command === 'desktop_connection_save') {
              const before = sources.find((item) => item.id === args.id);
              if (before && args.expectedRevision !== before.revision)
                throw new Error('Source changed. Close and reopen this source before saving.');

              const saved: SavedConnection = {
                id: before?.id ?? `source_${++sequence}`,
                revision: (before?.revision ?? 0) + 1,
                title: String(args.title ?? before?.title ?? args.provider),
                provider: args.provider as SavedConnection['provider'],
                models: before?.models ?? [{ id: 'fixture-model', name: 'Fixture model' }],
                hasCredential: !!args.apiKey || !!before?.hasCredential,
              };
              sources = [...sources.filter((item) => item.id !== saved.id), saved];

              return saved;
            }
            if (command === 'desktop_mcp_connections_list') return [];
            if (command === 'engine_connect') return engineInfo;
            if (command === 'engine_download')
              return {
                artifact: {
                  id: String(args.artifactId),
                  name: 'result.txt',
                  mediaType: 'text/plain',
                  size: 5,
                  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
                  origin: { runId: 'control-run' },
                },
                content: 'aGVsbG8=',
              };
            if (command === 'engine_cache') return { cache: {}, pending: [] };
            if (command === 'engine_call') {
              const call = args.call as EngineCall;
              if (call.op === 'profiles')
                return {
                  items: [{ id: 'local', title: 'Local profile', revision: 'sha256:fixture' }],
                };
              if (call.op === 'runs')
                return { items: runStarted ? [engineRun()] : [], nextCursor: null };
              if (call.op === 'requests')
                return {
                  items:
                    runStarted && !responded
                      ? [
                          {
                            id: 'control-request',
                            runId: 'control-run',
                            instanceId: 'root/review',
                            attemptId: 'attempt-1',
                            status: 'open',
                            prompt: 'Review the run started through MCP.',
                            createdAt: '2026-10-21T00:00:00Z',
                            deadline: '2030-01-01T00:00:00Z',
                            inputs: { values: {}, artifacts: {} },
                            responseSchema: {
                              type: 'object',
                              properties: { feedback: { type: 'string', title: 'Feedback' } },
                              required: ['feedback'],
                            },
                          },
                        ]
                      : [],
                  nextCursor: null,
                };
              if (call.op === 'start') {
                runStarted = true;
                return { run: { id: 'control-run' } };
              }
              if (call.op === 'respond') {
                responded = true;
                return { accepted: true, requestId: call.requestId };
              }

              return { items: [], nextCursor: null };
            }

            return 1;
          },
        },
      });
    },
    JSON.stringify({ initial, sources: options.sources ?? [] }),
  );
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as ControlFixture).controlListeners))
    .toContain('knotra-control-request');
}

async function request(page: Page, operation: string, args: Record<string, unknown> = {}) {
  return page.evaluate(
    ({ operation, args }) => (window as unknown as ControlFixture).controlRequest(operation, args),
    { operation, args },
  );
}

async function persisted(page: Page): Promise<State> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('control.workspace')!));
}

async function readPipeline(page: Page, id: string) {
  const reply = await request(page, 'pipeline_get', { id });
  expect(reply.error).toBeUndefined();
  return reply.result as { workspace: Workspace; revision: string };
}

test('MCP pipeline creation and updates are immediately visible and persist across reopen', async ({
  page,
}) => {
  const existing = workspace();
  const unrelated = workspace('unrelated', 'Unrelated draft');
  unrelated.source += '\n# unfinished local work';
  await open(page, [existing, unrelated]);
  const created = await request(page, 'pipeline_create', { source: source() });
  expect(created.error).toBeUndefined();

  const first = created.result as { workspace: Workspace; revision: string };
  await expect(
    page.getByRole('heading', { name: 'Controlled pipeline', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('rf__node-review')).toBeVisible();

  const beforeUpdate = await readPipeline(page, first.workspace.id);
  const updated = await request(page, 'pipeline_update', {
    id: first.workspace.id,
    source: source('Updated through MCP'),
    expectedRevision: beforeUpdate.revision,
  });

  expect(updated.error).toBeUndefined();
  await expect(
    page.getByRole('heading', { name: 'Updated through MCP', exact: true }),
  ).toBeVisible();

  const saved = await persisted(page);
  expect(saved.workspaces.slice(0, 2)).toEqual([existing, unrelated]);
  expect(saved.workspaces[2].source).toContain('Updated through MCP');
  expect(saved.activeId).toBe(first.workspace.id);
  await page.reload();
  await page.locator('.sidebar-pipelines > button').nth(2).click();
  await expect(
    page.getByRole('heading', { name: 'Updated through MCP', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('rf__node-review')).toBeVisible();
});

test('active editor typing and dirty drafts are protected even when the caller allows replacement', async ({
  page,
}) => {
  await open(page, [workspace()]);
  await page.locator('.sidebar-pipelines > button').first().click();
  await page.getByTestId('rf__node-review').click();
  const read = await readPipeline(page, 'existing');
  const prompt = page.locator('.inspector textarea').first();
  await prompt.fill('Unfinished prompt from the user');
  const focused = await request(page, 'pipeline_update', {
    id: 'existing',
    expectedRevision: read.revision,
    source: source('Should not replace typing'),
    allowDirty: true,
  });

  expect(focused.error?.code).toBe('busy');
  expect(focused.error?.message).toMatch(/editing|finish|focused/i);
  await expect(prompt).toHaveValue('Unfinished prompt from the user');
  expect((await persisted(page)).workspaces[0].source).toBe(read.workspace.source);
  await prompt.blur();
  await expect
    .poll(async () => (await persisted(page)).workspaces[0].source)
    .toContain('Unfinished prompt from the user');

  const dirty = await readPipeline(page, 'existing');
  const stale = await request(page, 'pipeline_update', {
    id: 'existing',
    expectedRevision: read.revision,
    source: source('Stale edit'),
  });

  expect(stale.error?.code).toBe('conflict');
  expect(stale.error?.message).toContain('changed');

  const refused = await request(page, 'pipeline_update', {
    id: 'existing',
    expectedRevision: dirty.revision,
    source: source('Unacknowledged edit'),
  });

  expect(refused.error?.code).toBe('dirty');
  expect(refused.error?.message).toContain('unsaved changes');

  const accepted = await request(page, 'pipeline_update', {
    id: 'existing',
    expectedRevision: dirty.revision,
    source: source('Acknowledged edit'),
    allowDirty: true,
  });

  expect(accepted.error).toBeUndefined();

  const current = (await persisted(page)).workspaces[0];
  expect(current.source).toContain('Acknowledged edit');
  expect(current.files).toEqual(read.workspace.files);
  expect(current.positions).toEqual(read.workspace.positions);
});

test('concurrent MCP edits serialize and stale revisions cannot overwrite the accepted edit', async ({
  page,
}) => {
  await open(page, [workspace()]);
  const read = await readPipeline(page, 'existing');
  const replies = await page.evaluate(
    ({ revision, first, second }) => {
      const fixture = window as unknown as ControlFixture;
      return Promise.all(
        [first, second].map((source) =>
          fixture.controlRequest('pipeline_update', {
            id: 'existing',
            expectedRevision: revision,
            source,
            activate: false,
          }),
        ),
      );
    },
    { revision: read.revision, first: source('First edit'), second: source('Second edit') },
  );

  expect(replies[0].error).toBeUndefined();
  expect(replies[1].error?.message).toContain('changed');

  const current = (await persisted(page)).workspaces[0];
  expect(current.source).toContain('First edit');
  expect(current.source).not.toContain('Second edit');
});

test('failed persistence rejects an MCP edit without changing the graph or saved package', async ({
  page,
}) => {
  await open(page, [workspace()]);
  await page.locator('.sidebar-pipelines > button').first().click();
  const read = await readPipeline(page, 'existing');
  const before = await persisted(page);
  await page.evaluate(() =>
    (window as unknown as ControlFixture).controlFailSave('Must not appear'),
  );
  const reply = await request(page, 'pipeline_update', {
    id: 'existing',
    expectedRevision: read.revision,
    source: source('Must not appear'),
  });

  expect(reply.error).toBeDefined();
  await expect(page.getByRole('heading', { name: 'Existing pipeline', exact: true })).toBeVisible();

  const after = await persisted(page);
  expect(after.workspaces[0].positions).toMatchObject(before.workspaces[0].positions!);
  expect({
    ...after,
    workspaces: after.workspaces.map((item, index) => ({
      ...item,
      positions: before.workspaces[index].positions,
      updatedAt: before.workspaces[index].updatedAt,
    })),
  }).toEqual(before);
});

test('MCP delete removes only the selected pipeline and keeps the remaining package visible', async ({
  page,
}) => {
  const other = workspace('other', 'Keep this pipeline');
  await open(page, [workspace(), other]);
  const read = await readPipeline(page, 'existing');
  const removed = await request(page, 'pipeline_delete', {
    id: 'existing',
    expectedRevision: read.revision,
  });

  expect(removed.error).toBeUndefined();
  expect(removed.result).toEqual({ deleted: 'existing' });
  expect((await persisted(page)).workspaces).toEqual([other]);
  await expect(page.locator('.sidebar-pipelines > button')).toHaveCount(1);
  await page.locator('.sidebar-pipelines > button').first().click();
  await expect(
    page.getByRole('heading', { name: 'Keep this pipeline', exact: true }),
  ).toBeVisible();
});

test('external source changes refresh open Settings while preserving the unfinished provider form', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const models = page.locator('.model-setup');
  await models.getByRole('button', { name: 'OpenAI API', exact: true }).click();
  await models.getByRole('textbox', { name: 'Source name', exact: true }).fill('Unfinished source');
  await models.locator('input[type="password"]').fill('keep-this-unsubmitted-key');
  await page.evaluate(() => {
    const fixture = window as unknown as ControlFixture;
    fixture.controlSources([
      {
        id: 'source_external',
        title: 'Added through MCP',
        provider: 'openai',
        models: [{ id: 'external-model', name: 'External model' }],
        hasCredential: true,
      },
    ]);
    fixture.controlChange({ connectionsChanged: true });
  });
  await expect(
    models.getByRole('button', { name: 'Edit Added through MCP', exact: true }),
  ).toBeVisible();
  await expect(models.getByRole('textbox', { name: 'Source name', exact: true })).toHaveValue(
    'Unfinished source',
  );
  await expect(models.locator('input[type="password"]')).toHaveValue('keep-this-unsubmitted-key');
  expect(JSON.stringify(await persisted(page))).not.toContain('keep-this-unsubmitted-key');
});

test('MCP run and human-response commands refresh the visible app without replacing its session', async ({
  page,
}) => {
  await open(page, [workspace()]);
  const connected = await request(page, 'engine_connect', { url: 'http://127.0.0.1:8787' });
  expect(connected.error).toBeUndefined();

  const started = await request(page, 'engine_call', {
    op: 'start',
    definitionId: 'control-definition',
    profile: 'local',
    inputs: {},
    artifacts: {},
    operationId: 'control-start-1',
  });

  expect(started.result).toEqual({ run: { id: 'control-run' } });
  expect((await request(page, 'app_navigate', { section: 'runs' })).error).toBeUndefined();
  await expect(
    page.locator('.run-table-row').getByText('Started through MCP', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  const feedback = page.getByRole('textbox', { name: 'Feedback', exact: true });
  await feedback.fill('Keep this unfinished response');
  const lifecycle = () =>
    page.evaluate(() =>
      (window as unknown as ControlFixture).controlCalls.filter((call) =>
        /^(engine_connect|engine_disconnect)$/.test(call.command),
      ),
    );
  const before = await lifecycle();
  await page.evaluate(() =>
    (window as unknown as ControlFixture).controlChange({
      connectionsChanged: true,
      engineChanged: true,
    }),
  );
  await expect(feedback).toHaveValue('Keep this unfinished response');

  const responded = await request(page, 'engine_call', {
    op: 'respond',
    requestId: 'control-request',
    outputs: { feedback: 'Approved through MCP' },
    operationId: 'control-response-1',
  });

  expect(responded.result).toEqual({ accepted: true, requestId: 'control-request' });
  await expect(feedback).toBeHidden();

  const downloaded = await request(page, 'artifact_download', { artifactId: 'control-artifact' });
  expect(downloaded.error).toBeUndefined();
  expect(downloaded.result).toMatchObject({
    artifact: { id: 'control-artifact', name: 'result.txt', size: 5 },
    content: 'aGVsbG8=',
  });
  expect(await lifecycle()).toEqual(before);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.locator('.run-table-row')).toContainText('Completed');
  expect((await persisted(page)).engineMode).toBe('manual');
});

test('a source edit cannot overwrite a newer MCP change and keeps its unsubmitted fields', async ({
  page,
}) => {
  const saved: SavedConnection = {
    id: 'source_shared',
    revision: 1,
    title: 'Work API',
    provider: 'openai',
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    hasCredential: true,
  };
  await open(page, [], { sources: [saved] });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const models = page.locator('.model-setup');
  await models.getByRole('button', { name: 'Edit Work API', exact: true }).click();
  await models.getByRole('textbox', { name: 'Source name', exact: true }).fill('Unsubmitted name');
  await models.locator('input[type="password"]').fill('unsubmitted-replacement-key');
  await page.evaluate((saved) => {
    const fixture = window as unknown as ControlFixture;
    fixture.controlSources([{ ...saved, revision: 2, title: 'Changed through MCP' }]);
    fixture.controlChange({ connectionsChanged: true });
  }, saved);
  await expect(
    models.getByRole('button', { name: 'Edit Changed through MCP', exact: true }),
  ).toBeVisible();
  await models.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(models.getByRole('alert')).toContainText('Source changed');
  await expect(models.getByRole('textbox', { name: 'Source name', exact: true })).toHaveValue(
    'Unsubmitted name',
  );
  await expect(models.locator('input[type="password"]')).toHaveValue('unsubmitted-replacement-key');
  await expect(
    models.getByRole('button', { name: 'Edit Changed through MCP', exact: true }),
  ).toBeVisible();

  const savedArgs = await page.evaluate(() =>
    (window as unknown as ControlFixture).controlCalls
      .filter((call) => call.command === 'desktop_connection_save')
      .map((call) => call.args),
  );

  expect(savedArgs).toHaveLength(1);
  expect(savedArgs[0].expectedRevision).toBe(1);
});

test('MCP provider sign-in progress appears and completes without replacing a typed source form', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await open(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const models = page.locator('.model-setup');
  await models.getByRole('button', { name: 'OpenAI API', exact: true }).click();
  await models.getByRole('textbox', { name: 'Source name', exact: true }).fill('Keep my API form');
  await models.locator('input[type="password"]').fill('keep-my-unsubmitted-key');
  await page.evaluate(() => {
    const fixture = window as unknown as ControlFixture;
    fixture.controlSourceStatus({
      sourcePhase: 'signing_in',
      sourceProvider: 'codex',
      sourceMessage: 'Finish account sign-in in your browser.',
      code: 'ABCD-1234',
      signInUrl: 'https://auth.openai.com/codex/device',
    });
    fixture.controlChange({ connectionsChanged: true });
  });
  const progress = models.locator('.external-provider-login');
  await expect(progress).toContainText('Codex');
  await expect(progress).toContainText('ABCD-1234');
  await expect(progress).toContainText('https://auth.openai.com/codex/device');
  await expect(models.getByRole('textbox', { name: 'Source name', exact: true })).toHaveValue(
    'Keep my API form',
  );
  await expect(models.locator('input[type="password"]')).toHaveValue('keep-my-unsubmitted-key');
  if (testInfo.project.name !== 'webkit')
    await progress.screenshot({ path: testInfo.outputPath('external-provider-sign-in-1000.png') });
  await page.evaluate(() =>
    (window as unknown as ControlFixture).controlSourceStatus({
      sourcePhase: 'signing_in',
      sourceProvider: 'codex',
      code: 'EFGH-5678',
      signInUrl: 'https://auth.openai.com/codex/device',
    }),
  );
  await expect(progress).toContainText('EFGH-5678');
  await page.evaluate(() =>
    (window as unknown as ControlFixture).controlSourceStatus({
      sourcePhase: 'idle',
      sourceProvider: 'codex',
      sourceMessage: 'Signed in. Save this model source to use the account in your nodes.',
    }),
  );
  await expect(progress).toBeHidden();
  await expect(models.getByRole('textbox', { name: 'Source name', exact: true })).toHaveValue(
    'Keep my API form',
  );
  await expect(models.locator('input[type="password"]')).toHaveValue('keep-my-unsubmitted-key');
  expect(
    await page.evaluate(() =>
      (window as unknown as ControlFixture).controlCalls.filter(
        (call) => call.command === 'desktop_provider_sign_in',
      ),
    ),
  ).toEqual([]);
});

for (const options of [
  { locale: 'en' as const, theme: 'dark' as const },
  { locale: 'ru' as const, theme: 'light' as const },
])
  test(`MCP control configuration is readable at minimum width in ${options.locale} ${options.theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await open(page, [], options);
    const translations: Record<string, string> = JSON.parse(
      readFileSync(`src/locales/${options.locale}.json`, 'utf8'),
    );
    await page
      .getByRole('button', { name: translations['navigation.settings'], exact: true })
      .click();
    const card = page.locator('.desktop-control');
    await expect(
      card.getByText(translations['desktopControl.ready'], { exact: true }),
    ).toBeVisible();
    await card.locator('summary').click();
    const configuration = card.getByRole('textbox', {
      name: translations['desktopControl.configuration'],
      exact: true,
    });
    const config = JSON.parse(await configuration.inputValue());
    expect(config.mcpServers.knotra.args).toContain('--bridge-file');
    expect(JSON.stringify(config)).not.toContain('token');
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await card.screenshot({
      path: testInfo.outputPath(`mcp-control-${options.locale}-${options.theme}-1000.png`),
    });
  });
