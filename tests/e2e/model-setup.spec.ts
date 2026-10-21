import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

type Scenario = {
  modelErrorAfterLoad?: boolean;
  modelEmpty?: boolean;
  pendingSignIn?: boolean;
  dockerMissing?: boolean;
  readyOnMount?: boolean;
  connectFailsOnce?: boolean;
  holdAutoReady?: boolean;
  saveFailsOnce?: boolean;
  pendingStart?: boolean;
  holdStartReady?: boolean;
  pendingStop?: boolean;
  runtimeStatusError?: boolean;
  holdRuntimeStatus?: boolean;
  restoredSignIn?: 'codex' | 'claude';
  pendingSourceApply?: boolean;
  runStatus?: 'waiting_human' | 'succeeded';
  savedSources?: {
    id: string;
    title: string;
    provider: string;
    baseUrl?: string;
    models: { id: string; name: string }[];
    hasCredential: boolean;
  }[];
};

async function nativeSetup(page: Page, scenario: Scenario = {}) {
  await page.addInitScript((scenario) => {
    const target = window as unknown as {
      isTauri: boolean;
      __TAURI_INTERNALS__: unknown;
      setupCalls: { command: string; args: Record<string, unknown> }[];
      savedWorkspace: unknown;
    };
    target.isTauri = true;
    target.setupCalls = [];
    let catalogAttempts = 0;
    let saveAttempts = 0;
    let startStatusChecks = 0;
    let connectionAttempts = 0;
    let finishStop: (() => void) | undefined;
    let finishRuntimeStatus: (() => void) | undefined;
    const statusReady = scenario.holdRuntimeStatus
      ? new Promise<void>((resolve) => {
          finishRuntimeStatus = resolve;
        })
      : Promise.resolve();
    let sources =
      JSON.parse(sessionStorage.getItem('fixture.sources') ?? 'null') ??
      scenario.savedSources ??
      [];
    let current = {
      phase: scenario.holdAutoReady ? 'starting' : scenario.readyOnMount ? 'ready' : 'idle',
      sourcePhase: scenario.restoredSignIn ? 'signing_in' : 'idle',
      sourceProvider: scenario.restoredSignIn,
      endpoint: scenario.readyOnMount ? 'http://127.0.0.1:8787' : undefined,
      configured: !!scenario.readyOnMount || !!scenario.holdAutoReady,
      sourcesState: 'current',
      sourceApplyError: undefined as string | undefined,
      engineGeneration: scenario.readyOnMount ? 1 : 0,
      connections: sources,
      dockerReady: !scenario.dockerMissing,
      runtimeAvailable: true,
      codexAvailable: true,
      claudeAvailable: true,
    };
    function persist() {
      sessionStorage.setItem('fixture.sources', JSON.stringify(sources));
      current = {
        ...current,
        connections: sources,
        sourcesState:
          current.phase === 'ready' && scenario.pendingSourceApply ? 'pending' : 'current',
        engineGeneration:
          current.engineGeneration +
          (current.phase === 'ready' && !scenario.pendingSourceApply ? 1 : 0),
      };
    }
    Object.assign(window, {
      releaseNativeStart: () => {
        current = { ...current, phase: 'ready', endpoint: 'http://127.0.0.1:8787' };
        window.dispatchEvent(new Event('knotra-engine-changed'));
      },
      releaseNativeStop: () => finishStop?.(),
      releaseNativeStatus: () => finishRuntimeStatus?.(),
      advanceNativeSources: (state: string, error?: string, notify = true) => {
        current = {
          ...current,
          sourcesState: state,
          sourceApplyError: error,
          engineGeneration: current.engineGeneration + (state === 'current' ? 1 : 0),
        };
        if (notify) window.dispatchEvent(new Event('knotra-engine-changed'));
      },
    });
    function catalog(provider: unknown) {
      if (scenario.modelEmpty) return [];
      return provider === 'codex' || provider === 'claude'
        ? [{ id: 'default', name: 'Account default' }]
        : [
            { id: 'fixture-model', name: 'Fixture model' },
            { id: 'fixture-second', name: 'Second model' },
          ];
    }
    target.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        target.setupCalls.push({ command, args });
        if (command === 'workspace_load')
          return JSON.parse(sessionStorage.getItem('fixture.workspace') ?? 'null');
        if (command === 'workspace_save') {
          target.savedWorkspace = args.value;
          sessionStorage.setItem('fixture.workspace', JSON.stringify(args.value));
          return;
        }
        if (command === 'desktop_setup_status') {
          await statusReady;
          if (scenario.runtimeStatusError) throw 'Runtime status unavailable';
          if (
            current.phase === 'starting' &&
            !scenario.holdAutoReady &&
            !scenario.holdStartReady &&
            ++startStatusChecks >= 2
          )
            current = { ...current, phase: 'ready' };
          return current;
        }
        if (command === 'desktop_connections_list') return sources;
        if (command === 'desktop_connection_save') {
          saveAttempts++;
          if (scenario.saveFailsOnce && saveAttempts === 1) throw `Cannot save ${args.apiKey}`;
          const existing = sources.find((source: { id: string }) => source.id === args.id);
          const models = args.model
            ? [{ id: String(args.model), name: String(args.model) }]
            : catalog(args.provider);
          const source = {
            id: args.id ?? `source_${sources.length + 1}`,
            title: args.title ?? args.provider,
            provider: args.provider,
            ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
            models,
            defaultModel: models[0]?.id,
            hasCredential: !!args.apiKey || existing?.hasCredential || false,
          };
          sources = [...sources.filter((item: { id: string }) => item.id !== source.id), source];
          persist();
          return source;
        }
        if (command === 'desktop_connection_refresh') {
          const source = sources.find((item: { id: string }) => item.id === args.id);
          return source;
        }
        if (command === 'desktop_connection_remove') {
          sources = sources.filter((item: { id: string }) => item.id !== args.id);
          persist();
          return sources;
        }
        if (command === 'desktop_open_dependency') {
          if (args.dependency === 'docker') current = { ...current, dockerReady: true };
          return;
        }
        if (command === 'desktop_setup_cancel') {
          if (scenario.pendingStop)
            await new Promise<void>((resolve) => {
              finishStop = resolve;
            });
          current = { ...current, phase: 'idle', endpoint: undefined };
          return current;
        }
        if (command === 'desktop_provider_sign_in_cancel') {
          current = { ...current, sourcePhase: 'idle' };
          return current;
        }
        if (command === 'desktop_provider_sign_in') {
          current = { ...current, sourcePhase: scenario.pendingSignIn ? 'signing_in' : 'idle' };
          return { ...current, signInUrl: 'https://auth.openai.com/device', code: 'ABCD-EFGH' };
        }
        if (command === 'desktop_provider_models') {
          catalogAttempts++;
          if (scenario.modelErrorAfterLoad && catalogAttempts > 1)
            throw `Catalog unavailable for ${args.apiKey}`;
          return catalog(args.provider);
        }
        if (command === 'desktop_engine_start') {
          startStatusChecks = 0;
          current = {
            ...current,
            phase: scenario.pendingStart ? 'starting' : 'ready',
            endpoint: 'http://127.0.0.1:8787',
            configured: true,
            sourcesState: 'current',
            sourceApplyError: undefined,
            engineGeneration: current.engineGeneration + 1,
          };
          return current;
        }
        if (command === 'engine_connect') {
          connectionAttempts++;
          if (scenario.connectFailsOnce && connectionAttempts === 1)
            throw 'Temporary attach failure';
          return {
            protocol: 'knotra.desktop/1',
            engineId: 'setup-fixture',
            principalId: 'operator',
            version: 'test',
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
        }
        if (command === 'engine_cache') return { cache: {}, pending: [] };
        if (command === 'engine_call') {
          const call = args.call as { op: string };
          if (call.op === 'profiles')
            return {
              items: [
                {
                  id: 'local',
                  title: 'Local profile',
                  revision: `sha256:fixture_${current.engineGeneration}`,
                },
              ],
            };
          if (scenario.runStatus && call.op === 'runs')
            return {
              items: [
                {
                  id: 'saved-run',
                  definitionId: 'saved-definition',
                  title: 'Preserved engine run',
                  status: scenario.runStatus,
                  createdAt: '2026-10-21T00:00:00Z',
                  updatedAt: '2026-10-21T00:00:00Z',
                  profile: 'local',
                  package: {
                    entrypoint: 'pipeline.yaml',
                    source: '# Immutable saved run package',
                    files: [
                      { path: 'pipeline.yaml', content: btoa('# Immutable saved run package') },
                    ],
                  },
                  inputs: {},
                  inputArtifacts: {},
                  outputs: {},
                  artifacts: [],
                  instances: [],
                  diagnostics: [],
                  availableActions: [],
                },
              ],
              nextCursor: null,
            };
          if (scenario.runStatus === 'waiting_human' && call.op === 'requests')
            return {
              items: [
                {
                  id: 'saved-request',
                  runId: 'saved-run',
                  instanceId: 'root/review',
                  attemptId: 'attempt-1',
                  status: 'open',
                  prompt: 'Review this draft without losing your response.',
                  createdAt: '2026-10-21T00:00:00Z',
                  deadline: '2030-01-01T00:00:00Z',
                  inputs: {
                    values: { draft: 'A draft from the running pipeline.' },
                    artifacts: {},
                  },
                  responseSchema: {
                    type: 'object',
                    properties: { feedback: { type: 'string' } },
                    required: ['feedback'],
                  },
                },
              ],
              nextCursor: null,
            };
          return { items: [], nextCursor: null };
        }
        return 1;
      },
    };
  }, scenario);
}
async function openSetup(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.model-setup')).toBeVisible();
}
async function calls(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { setupCalls: { command: string; args: Record<string, unknown> }[] })
        .setupCalls,
  );
}
async function advanceSources(
  page: Page,
  state: 'pending' | 'applying' | 'current' | 'error',
  error?: string,
  notify = true,
) {
  await page.evaluate(
    ({ state, error, notify }) =>
      (
        window as unknown as {
          advanceNativeSources: (state: string, error?: string, notify?: boolean) => void;
        }
      ).advanceNativeSources(state, error, notify),
    { state, error, notify },
  );
}
async function nativeWorkspace(page: Page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture.workspace')!));
}
async function existingEngine(page: Page) {
  const input = page.getByRole('textbox', { name: 'Engine base URL', exact: true });
  if (await input.isHidden()) await page.locator('[data-tour="engine"] summary').click();
  return input;
}
async function apiSource(page: Page, name = 'My API') {
  await chooseProvider(page, 'OpenAI API');
  await page.getByLabel('Source name', { exact: true }).fill(name);
  await page.getByLabel('API key', { exact: true }).fill('secret-api-key');
}
async function chooseProvider(page: Page, name: string) {
  await page
    .getByRole('group', { name: 'Choose a provider', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(page.getByLabel('Source name', { exact: true })).toBeFocused();
}
const saved = [
  {
    id: 'api',
    title: 'Work API',
    provider: 'openai',
    models: [{ id: 'gpt-work', name: 'Work model' }],
    hasCredential: true,
  },
  {
    id: 'codex',
    title: 'My Codex',
    provider: 'codex',
    models: [{ id: 'default', name: 'Account default' }],
    hasCredential: false,
  },
  {
    id: 'claude',
    title: 'My Claude',
    provider: 'claude',
    models: [{ id: 'default', name: 'Account default' }],
    hasCredential: false,
  },
];

test('browser preview explains native setup and never invokes native commands', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: () => {
        throw new Error('Browser must not invoke native setup');
      },
    };
  });
  await openSetup(page);
  await expect(
    page.getByText('Manage saved sources in the desktop app.', { exact: false }),
  ).toBeVisible();
  const providers = page.getByRole('group', { name: 'Choose a provider', exact: true });
  await expect(providers.getByRole('button')).toHaveCount(6);
  for (const button of await providers.getByRole('button').all())
    await expect(button).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save source', exact: true })).toHaveCount(0);
  await expect(page.locator('.engine-setup')).toHaveCount(0);
});

test('provider choices open a focused form and changing provider clears credentials and catalog', async ({
  page,
}, testInfo) => {
  await nativeSetup(page);
  await openSetup(page);
  const providers = page.getByRole('group', { name: 'Choose a provider', exact: true });
  await expect(providers.getByRole('button')).toHaveCount(6);
  for (const name of [
    'OpenAI API',
    'Anthropic API',
    'Codex',
    'Claude Code',
    'OpenAI-compatible',
    'Ollama',
  ])
    await expect(providers.getByRole('button', { name, exact: true })).toBeEnabled();
  await expect(page.getByLabel('Source name', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save source', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('provider-chooser-en-1440.png') });
  await apiSource(page);
  await page.getByRole('button', { name: 'Load models', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Available models', exact: true })).toContainText(
    'Second model',
  );
  await page.screenshot({ path: testInfo.outputPath('provider-config-en-1440.png') });
  await page.getByRole('button', { name: 'Change provider', exact: true }).click();
  await expect(providers).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose a provider', exact: true })).toBeFocused();
  await expect(page.getByLabel('API key', { exact: true })).toHaveCount(0);
  await chooseProvider(page, 'OpenAI-compatible');
  await expect(page.getByLabel('API key (optional)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue('');
  await expect(page.getByRole('list', { name: 'Available models', exact: true })).toHaveCount(0);
  expect(
    (await calls(page)).filter((call) =>
      /desktop_connection_save|desktop_provider_sign_in|desktop_engine_start/.test(call.command),
    ),
  ).toEqual([]);
});

test('saving a source stores its model catalog without starting the engine or exposing its key', async ({
  page,
}) => {
  await nativeSetup(page);
  await openSetup(page);
  await apiSource(page);
  await page.getByRole('button', { name: 'Load models', exact: true }).click();
  await expect(page.getByText('2 models available', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Available models', exact: true })).toContainText(
    'Second model',
  );
  await page.getByRole('button', { name: 'Save source', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Saved model sources' })).toContainText('My API');
  await expect(page.getByLabel('API key', { exact: true })).toHaveCount(0);
  const recorded = await calls(page);
  expect(recorded.find((call) => call.command === 'desktop_connection_save')?.args).toEqual({
    title: 'My API',
    provider: 'openai',
    apiKey: 'secret-api-key',
  });
  expect(
    recorded.filter((call) => /desktop_engine_start|desktop_provider_sign_in/.test(call.command)),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        JSON.stringify(localStorage) +
        JSON.stringify(sessionStorage) +
        JSON.stringify((window as unknown as { savedWorkspace: unknown }).savedWorkspace),
    ),
  ).not.toContain('secret-api-key');
});

test('API, Codex and Claude sources coexist and are restored on reopen', async ({ page }) => {
  await nativeSetup(page);
  await openSetup(page);
  await apiSource(page);
  await page.getByRole('button', { name: 'Save source', exact: true }).click();
  await page.getByRole('button', { name: 'Add source', exact: true }).click();
  await apiSource(page, 'Second API');
  await page.getByRole('button', { name: 'Save source', exact: true }).click();
  for (const [provider, name] of [
    ['Codex', 'My Codex'],
    ['Claude Code', 'My Claude'],
  ]) {
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    await chooseProvider(page, provider);
    await page.getByLabel('Source name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Use signed-in account', exact: true }).click();
    await page.getByRole('button', { name: 'Save source', exact: true }).click();
  }
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const list = page.getByRole('list', { name: 'Saved model sources' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list).toContainText('Second API');
  await expect(list).toContainText('My API');
  await expect(list).toContainText('My Codex');
  await expect(list).toContainText('My Claude');
  expect(
    (await calls(page)).filter((call) =>
      /desktop_engine_start|desktop_provider_sign_in/.test(call.command),
    ),
  ).toEqual([]);
});

test('editing a saved source reuses its credential; refresh and remove are independent of runtime', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved });
  await openSetup(page);
  await page.getByRole('button', { name: 'Edit Work API', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Choose a provider', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await page.getByLabel('Source name', { exact: true }).fill('Renamed API');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh Renamed API', exact: true }).click();
  await page.getByRole('button', { name: 'Remove My Codex', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Saved model sources' }).getByRole('listitem'),
  ).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove My Claude', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Renamed API', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Choose a provider', exact: true })).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.find((call) => call.command === 'desktop_connection_save')?.args).toEqual({
    id: 'api',
    title: 'Renamed API',
    provider: 'openai',
  });
  expect(
    recorded.filter((call) => /desktop_engine_start|desktop_setup_cancel/.test(call.command)),
  ).toEqual([]);
});

test('editing an imported API source retains its endpoint for saved-key refresh and key replacement', async ({
  page,
}) => {
  const baseUrl = 'https://gateway.example/v1';
  await nativeSetup(page, { savedSources: [{ ...saved[0], baseUrl }] });
  await openSetup(page);
  await page.getByRole('button', { name: 'Edit Work API', exact: true }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Load models', exact: true }).click();
  expect(
    (await calls(page))
      .filter((call) => call.command === 'desktop_connection_refresh')
      .map((call) => call.args),
  ).toEqual([{ id: 'api' }]);
  expect((await calls(page)).filter((call) => call.command === 'desktop_provider_models')).toEqual(
    [],
  );
  await page.getByLabel('API key', { exact: true }).fill('replacement-api-key');
  await page.getByRole('button', { name: 'Load models', exact: true }).click();
  expect(
    (await calls(page))
      .filter((call) => call.command === 'desktop_provider_models')
      .map((call) => call.args),
  ).toEqual([
    {
      provider: 'openai',
      apiKey: 'replacement-api-key',
      baseUrl,
    },
  ]);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect(
    (await calls(page)).find((call) => call.command === 'desktop_connection_save')?.args,
  ).toEqual({
    id: 'api',
    title: 'Work API',
    provider: 'openai',
    apiKey: 'replacement-api-key',
    baseUrl,
  });
});

test('canceling a source edit discards its key and restores focus without saving', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved });
  await openSetup(page);
  await page.getByRole('button', { name: 'Edit Work API', exact: true }).click();
  await page.getByLabel('Source name', { exact: true }).fill('Unsubmitted name');
  await page.getByLabel('API key', { exact: true }).fill('unsubmitted-key');
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add source', exact: true })).toBeFocused();
  const list = page.getByRole('list', { name: 'Saved model sources', exact: true });
  await expect(list).toContainText('Work API');
  await expect(list).not.toContainText('Unsubmitted name');
  expect((await calls(page)).filter((call) => call.command === 'desktop_connection_save')).toEqual(
    [],
  );
  await page.getByRole('button', { name: 'Add source', exact: true }).click();
  await chooseProvider(page, 'OpenAI API');
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
});

test('a failed save keeps the key for explicit retry and redacts it from errors', async ({
  page,
}) => {
  await nativeSetup(page, { saveFailsOnce: true });
  await openSetup(page);
  await apiSource(page);
  await page.getByRole('button', { name: 'Save source', exact: true }).click();
  await expect(page.locator('.model-setup [role="alert"]')).toContainText('Cannot save');
  await expect(page.locator('.model-setup [role="alert"]')).not.toContainText('secret-api-key');
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('secret-api-key');
  await page.getByRole('button', { name: 'Save source', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Saved model sources' })).toContainText('My API');
});

test('sign in and its cancellation never stop an existing engine', async ({ page }) => {
  await nativeSetup(page, { pendingSignIn: true, readyOnMount: true });
  await openSetup(page);
  await chooseProvider(page, 'Codex');
  await expect(page.getByRole('button', { name: 'Save source', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('ABCD-EFGH', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Change provider', exact: true })).toBeEnabled();
  await expect(page.locator('.engine-setup')).toContainText('Running');
  expect(
    (await calls(page)).filter((call) => call.command === 'desktop_provider_sign_in'),
  ).toHaveLength(1);
  expect(
    (await calls(page)).filter((call) => call.command === 'desktop_provider_sign_in_cancel'),
  ).toHaveLength(1);
  expect((await calls(page)).filter((call) => call.command === 'desktop_setup_cancel')).toEqual([]);
});

test('engine start and stop live in a separate section and use all saved sources', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved });
  await openSetup(page);
  await expect(
    page.locator('.model-setup').getByRole('button', { name: 'Start local engine', exact: true }),
  ).toHaveCount(0);
  await page
    .locator('.engine-setup')
    .getByRole('button', { name: 'Start local engine', exact: true })
    .click();
  await expect(page.locator('.engine-setup')).toContainText('Running');
  await page
    .locator('.engine-setup')
    .getByRole('button', { name: 'Stop local engine', exact: true })
    .click();
  await expect(page.locator('.engine-setup')).toContainText('Stopped');
  const recorded = await calls(page);
  expect(
    recorded.filter((call) => call.command === 'desktop_engine_start').map((call) => call.args),
  ).toEqual([{}]);
  expect(recorded.some((call) => call.command === 'engine_connect')).toBe(true);
  expect(recorded.filter((call) => call.command === 'desktop_connection_save')).toEqual([]);
});

test('catalog failure keeps a manual model fallback and rejects credential-bearing URLs', async ({
  page,
}) => {
  await nativeSetup(page, { modelErrorAfterLoad: true });
  await openSetup(page);
  await chooseProvider(page, 'OpenAI-compatible');
  await page.getByLabel('API key (optional)', { exact: true }).fill('provider-secret');
  const base = page.getByRole('textbox', { name: 'API base URL', exact: true });
  for (const invalid of ['ftp://host/v1', 'https://key@host/v1', 'https://host/v1?key=secret']) {
    await base.fill(invalid);
    await expect(page.getByRole('button', { name: 'Save source', exact: true })).toBeDisabled();
  }
  await base.fill('https://models.example/v1/');
  await page.getByRole('button', { name: 'Load models', exact: true }).click();
  await page.getByRole('button', { name: 'Load models', exact: true }).click();
  const catalogError = page.locator('.model-setup').getByRole('alert');
  await expect(catalogError).toHaveText('Catalog unavailable for …');
  await expect(catalogError).not.toContainText('provider-secret');
  await page.getByText('Enter a model ID when the catalog is unavailable', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Model ID', exact: true }).fill('invalid model');
  await expect(page.getByRole('button', { name: 'Save source', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Model ID', exact: true }).fill('org/custom-model');
  await page.getByRole('button', { name: 'Save source', exact: true }).click();
  expect(
    (await calls(page)).find((call) => call.command === 'desktop_connection_save')?.args,
  ).toEqual({
    provider: 'openai-compatible',
    apiKey: 'provider-secret',
    baseUrl: 'https://models.example/v1',
    model: 'org/custom-model',
  });
});

test('Docker and optional Ollama open only after their buttons are clicked', async ({ page }) => {
  await nativeSetup(page, { dockerMissing: true });
  await openSetup(page);
  expect((await calls(page)).filter((call) => call.command === 'desktop_open_dependency')).toEqual(
    [],
  );
  await page.getByRole('button', { name: 'Open or install Docker', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open or install Docker', exact: true }),
  ).toHaveCount(0);
  await chooseProvider(page, 'Ollama');
  await page.getByRole('button', { name: 'Open or install Ollama', exact: true }).click();
  expect(
    (await calls(page))
      .filter((call) => call.command === 'desktop_open_dependency')
      .map((call) => call.args),
  ).toEqual([{ dependency: 'docker' }, { dependency: 'ollama' }]);
  expect((await calls(page)).filter((call) => call.command === 'desktop_engine_start')).toEqual([]);
});

test('Russian source management keeps aligned cards at native minimum size in both themes', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved });
  await page.addInitScript(() => Object.defineProperty(navigator, 'language', { value: 'ru-RU' }));
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page
    .locator('.model-setup')
    .getByRole('button', { name: 'Добавить источник', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Выберите провайдера', exact: true })
    .getByRole('button', { name: 'Anthropic API', exact: true })
    .click();
  const cards = await page.locator('.settings-page .settings-card').evaluateAll((elements) =>
    elements.map((element) => {
      const { x, width } = element.getBoundingClientRect();
      return { x, width };
    }),
  );
  for (const card of cards.slice(1)) expect(card).toEqual(cards[0]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('sources-ru-dark-1000.png'),
    fullPage: true,
  });
  await page.getByLabel('API-ключ', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('sources-form-ru-dark-1000.png') });
  await page.locator('.engine-setup').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('engine-ru-dark-1000.png') });
  await page.getByRole('radio', { name: 'Светлая', exact: true }).click();
  await page.locator('.settings-page h1').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('sources-ru-light-1000.png'),
    fullPage: true,
  });
  await page.getByLabel('API-ключ', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('sources-form-ru-light-1000.png') });
  await page.locator('.engine-setup').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('engine-ru-light-1000.png') });
});

for (const viewport of [
  { width: 1000, height: 680 },
  { width: 1440, height: 940 },
]) {
  test(`native source tour keeps its spotlight and usable form at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await nativeSetup(page);
    await page.addInitScript(() => localStorage.removeItem('knotra.tour.v1'));
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: 'Create learning pipeline', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const guide = page.getByRole('region', { name: 'Knotra tour', exact: true });
    await expect(guide).toContainText('5 of 8');
    await expect(page.locator('.workspace-tour-target')).toBeVisible();
    await expect(guide).toHaveCSS('position', 'fixed');
    await page.screenshot({
      path: testInfo.outputPath('source-tour-settings.png'),
      animations: 'disabled',
    });
    await chooseProvider(page, 'OpenAI API');
    await page.getByLabel('Source name', { exact: true }).fill('Tour API');
    await page.getByLabel('API key', { exact: true }).fill('tour-key');
    await page.getByRole('button', { name: 'Load models', exact: true }).click();
    await expect(
      guide.getByRole('button', { name: 'Skip model setup', exact: true }),
    ).toBeVisible();
    const panel = (await guide.boundingBox())!;
    const source = (await page.locator('.model-setup').boundingBox())!;
    expect(source.x + source.width).toBeLessThanOrEqual(panel.x - 16);
    expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height);
    await expect(page.locator('.workspace-tour-target')).toHaveCSS('pointer-events', 'none');
    const content = (await page.locator('.main-content').boundingBox())!;
    await expect
      .poll(async () => (await page.locator('.workspace-tour-target').boundingBox())!.y)
      .toBeGreaterThanOrEqual(content.y);
    await page.screenshot({
      path: testInfo.outputPath('source-tour-form.png'),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Save source', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Saved model sources' })).toContainText('Tour API');
    await page.getByRole('button', { name: 'Resources', exact: true }).click();
    await expect(page.locator('.workspace-tour-target')).toBeVisible();
    const settings = (await page
      .getByRole('button', { name: 'Settings', exact: true })
      .boundingBox())!;
    await expect
      .poll(async () => (await page.locator('.workspace-tour-target').boundingBox())?.x ?? Infinity)
      .toBeLessThanOrEqual(settings.x);
    await expect(guide).toHaveCSS('position', 'fixed');
    await guide.getByRole('button', { name: 'Skip model setup', exact: true }).click();
    await expect(guide).toContainText('6 of 8');
    await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible();
    const nodeModels = page.locator('[data-tour="node-model"]');
    await expect(nodeModels.getByRole('textbox')).toHaveCount(0);
    await nodeModels
      .getByRole('combobox', { name: 'Source', exact: true })
      .selectOption({ label: 'Tour API' });
    const nodeModel = nodeModels.getByRole('combobox', { name: 'Model', exact: true });
    await nodeModel.selectOption('fixture-second');
    await expect(nodeModel).toHaveValue('fixture-second');
    await guide.getByRole('button', { name: 'Next', exact: true }).click();
    await guide.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(nodeModel).toHaveValue('fixture-second');
    await page.screenshot({
      path: testInfo.outputPath('source-tour-node-selection.png'),
      animations: 'disabled',
    });
    expect((await calls(page)).filter((call) => call.command === 'desktop_engine_start')).toEqual(
      [],
    );
  });
}

test('changed sources apply automatically and refresh catalogs without a frontend restart', async ({
  page,
}) => {
  await nativeSetup(page, {
    savedSources: saved,
    readyOnMount: true,
    pendingSourceApply: true,
    runStatus: 'succeeded',
  });
  await openSetup(page);
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  const lifecycleBefore = (await calls(page)).filter((call) =>
    /^(engine_connect|engine_disconnect|desktop_engine_start|desktop_setup_cancel)$/.test(
      call.command,
    ),
  );
  await expect
    .poll(
      async () =>
        (await calls(page)).filter(
          (call) =>
            call.command === 'engine_call' && (call.args.call as { op: string }).op === 'profiles',
        ).length,
    )
    .toBeGreaterThan(0);
  const profilesBefore = (await calls(page)).filter(
    (call) =>
      call.command === 'engine_call' && (call.args.call as { op: string }).op === 'profiles',
  ).length;
  await page.getByRole('button', { name: 'Edit Work API', exact: true }).click();
  await page.getByLabel('Source name', { exact: true }).fill('Updated work API');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const list = page.getByRole('list', { name: 'Saved model sources' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list).toContainText('My Codex');
  await expect(list).toContainText('My Claude');
  await expect(page.getByRole('button', { name: 'Restart local engine', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('.engine-setup')).toContainText('They will apply automatically');
  await advanceSources(page, 'applying');
  await expect(page.locator('.engine-setup')).toContainText('Applying connections.');
  await advanceSources(page, 'current');
  await expect
    .poll(
      async () =>
        (await calls(page)).filter(
          (call) =>
            call.command === 'engine_call' && (call.args.call as { op: string }).op === 'profiles',
        ).length,
      { timeout: 6000 },
    )
    .toBeGreaterThan(profilesBefore);
  expect(
    (await calls(page)).filter((call) =>
      /^(engine_connect|engine_disconnect|desktop_engine_start|desktop_setup_cancel)$/.test(
        call.command,
      ),
    ),
  ).toEqual(lifecycleBefore);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.getByText('Preserved engine run', { exact: true })).toBeVisible();
});

test('a configured native engine is attached on open and after restart without UI starting it again', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved, readyOnMount: true });
  await page.goto('/');
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  expect((await calls(page)).filter((call) => call.command === 'desktop_engine_start')).toEqual([]);
  await page.reload();
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Saved model sources' }).getByRole('listitem'),
  ).toHaveCount(3);
  await expect(page.locator('.engine-setup')).toContainText('Running');
  expect(
    (await calls(page)).filter((call) =>
      /desktop_engine_start|desktop_provider_sign_in/.test(call.command),
    ),
  ).toEqual([]);
});

test('an explicit start attaches when setup finishes after navigating away', async ({ page }) => {
  await nativeSetup(page, { savedSources: saved, readyOnMount: true, pendingStart: true });
  await openSetup(page);
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  await page
    .locator('.engine-setup')
    .getByRole('button', { name: 'Stop local engine', exact: true })
    .click();
  await page
    .locator('.engine-setup')
    .getByRole('button', { name: 'Start local engine', exact: true })
    .click();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(2);
  expect(
    (await calls(page)).filter((call) => call.command === 'desktop_engine_start'),
  ).toHaveLength(1);
});

test('saved sources stay manageable when runtime status cannot be read', async ({ page }) => {
  await nativeSetup(page, { savedSources: saved, runtimeStatusError: true });
  await openSetup(page);
  await expect(
    page.getByRole('list', { name: 'Saved model sources' }).getByRole('listitem'),
  ).toHaveCount(3);
  await page.getByRole('button', { name: 'Edit Work API', exact: true }).click();
  await page.getByLabel('Source name', { exact: true }).fill('Still editable');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Saved model sources' })).toContainText(
    'Still editable',
  );
  expect((await calls(page)).filter((call) => call.command === 'desktop_engine_start')).toEqual([]);
});

test('saved sources and unsaved edits stay usable while runtime status is delayed', async ({
  page,
}) => {
  await nativeSetup(page, {
    savedSources: saved,
    holdRuntimeStatus: true,
    restoredSignIn: 'claude',
  });
  await openSetup(page);
  const list = page.getByRole('list', { name: 'Saved model sources', exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await page.getByRole('button', { name: 'Add source', exact: true }).click();
  await apiSource(page, 'Unsaved connection');
  await page.evaluate(() =>
    (window as unknown as { releaseNativeStatus: () => void }).releaseNativeStatus(),
  );
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByLabel('Source name', { exact: true })).toHaveValue('Unsaved connection');
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('secret-api-key');
  await expect(page.getByRole('button', { name: 'Save source', exact: true })).toBeEnabled();
  expect(
    (await calls(page)).filter((call) =>
      /desktop_connection_save|desktop_engine_start/.test(call.command),
    ),
  ).toEqual([]);
});

test('configured startup retries a temporary attach failure without starting another engine', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved, readyOnMount: true, connectFailsOnce: true });
  await openSetup(page);
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(2);
  expect(
    (await calls(page)).filter((call) => call.command === 'desktop_engine_start'),
  ).toHaveLength(0);
});

test('a manual engine connection is not replaced when local startup finishes', async ({ page }) => {
  await nativeSetup(page, { savedSources: saved, holdAutoReady: true });
  await openSetup(page);
  await page.locator('[data-tour="engine"] summary').click();
  await page
    .getByRole('textbox', { name: 'Engine base URL', exact: true })
    .fill('http://127.0.0.1:9999');
  await page.getByRole('button', { name: 'Connect engine', exact: true }).click();
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  await page.evaluate(() =>
    (window as unknown as { releaseNativeStart: () => void }).releaseNativeStart(),
  );
  await page.waitForTimeout(300);
  expect((await calls(page)).filter((call) => call.command === 'engine_connect')).toHaveLength(1);
});

test('a ready event completes a pending start and source changes no longer need a restart', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved, pendingStart: true, holdStartReady: true });
  await openSetup(page);
  await page
    .locator('.engine-setup')
    .getByRole('button', { name: 'Start local engine', exact: true })
    .click();
  await page.evaluate(() =>
    (window as unknown as { releaseNativeStart: () => void }).releaseNativeStart(),
  );
  await expect(page.locator('.engine-setup')).toContainText('Running');
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  const lifecycleBefore = (await calls(page)).filter((call) =>
    /^(engine_connect|engine_disconnect|desktop_engine_start|desktop_setup_cancel)$/.test(
      call.command,
    ),
  );
  await page.getByRole('button', { name: 'Edit Work API', exact: true }).click();
  await page.getByLabel('Source name', { exact: true }).fill('Updated work API');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restart local engine', exact: true })).toHaveCount(
    0,
  );
  expect(
    (await calls(page)).filter((call) =>
      /^(engine_connect|engine_disconnect|desktop_engine_start|desktop_setup_cancel)$/.test(
        call.command,
      ),
    ),
  ).toEqual(lifecycleBefore);
});

test('stopping the engine still disconnects after leaving Settings', async ({ page }) => {
  await nativeSetup(page, { savedSources: saved, readyOnMount: true, pendingStop: true });
  await openSetup(page);
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  const disconnects = (await calls(page)).filter(
    (call) => call.command === 'engine_disconnect',
  ).length;
  await page
    .locator('.engine-setup')
    .getByRole('button', { name: 'Stop local engine', exact: true })
    .click();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { releaseNativeStop: () => void }).releaseNativeStop(),
  );
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_disconnect').length,
    )
    .toBe(disconnects + 1);
});

test('waiting human review keeps its response and session while model source changes are pending', async ({
  page,
}) => {
  await nativeSetup(page, {
    savedSources: saved,
    readyOnMount: true,
    pendingSourceApply: true,
    runStatus: 'waiting_human',
  });
  await openSetup(page);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  const feedback = page.getByRole('textbox', { name: 'Feedback', exact: true });
  await feedback.fill('An unsent response that must survive source changes.');
  const lifecycleBefore = (await calls(page)).filter((call) =>
    /^(engine_connect|engine_disconnect|desktop_engine_start|desktop_setup_cancel)$/.test(
      call.command,
    ),
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Work API', exact: true }).click();
  await page.getByLabel('Source name', { exact: true }).fill('Updated work API');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.engine-setup')).toContainText('They will apply automatically');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(feedback).toHaveValue('An unsent response that must survive source changes.');
  expect(
    (await calls(page)).filter((call) =>
      /^(engine_connect|engine_disconnect|desktop_engine_start|desktop_setup_cancel)$/.test(
        call.command,
      ),
    ),
  ).toEqual(lifecycleBefore);
});

test('source apply errors preserve the working session and recover without manual restart', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved, readyOnMount: true });
  await openSetup(page);
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  const lifecycleBefore = (await calls(page)).filter((call) =>
    /^(engine_connect|engine_disconnect|desktop_engine_start|desktop_setup_cancel)$/.test(
      call.command,
    ),
  );
  await advanceSources(page, 'error', 'The source update will be retried.');
  await expect(page.locator('.engine-setup').getByRole('alert')).toHaveText(
    'The source update will be retried.',
  );
  await expect(page.locator('.engine-setup')).toContainText('Knotra will retry automatically.');
  await advanceSources(page, 'current', undefined, false);
  await expect(page.locator('.engine-setup').getByRole('alert')).toHaveCount(0, {
    timeout: 3000,
  });
  expect(
    (await calls(page)).filter((call) =>
      /^(engine_connect|engine_disconnect|desktop_engine_start|desktop_setup_cancel)$/.test(
        call.command,
      ),
    ),
  ).toEqual(lifecycleBefore);
});

test('existing engine connects once on submit and keeps manual selection across app reopen', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved, readyOnMount: true });
  await openSetup(page);
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  const address = await existingEngine(page);
  await expect(page.getByRole('button', { name: 'Save address', exact: true })).toHaveCount(0);
  await address.fill('http://127.0.0.1:9999/');
  expect((await nativeWorkspace(page)).engineUrl).toBe('http://127.0.0.1:8787');
  expect((await calls(page)).filter((call) => call.command === 'engine_connect')).toHaveLength(1);
  await page
    .getByRole('textbox', { name: 'Engine access token', exact: true })
    .fill('session-only-token');
  await address.press('Enter');
  await expect
    .poll(async () => (await nativeWorkspace(page)).engineUrl)
    .toBe('http://127.0.0.1:9999');
  expect((await nativeWorkspace(page)).engineMode).toBe('manual');
  const connection = (await calls(page))
    .filter((call) => call.command === 'engine_connect')
    .at(-1)!;
  expect(connection.args).toEqual({ url: 'http://127.0.0.1:9999', token: 'session-only-token' });
  await expect(page.getByRole('textbox', { name: 'Engine access token', exact: true })).toHaveValue(
    '',
  );
  expect(JSON.stringify(await nativeWorkspace(page))).not.toContain('session-only-token');
  await page.reload();
  await openSetup(page);
  await expect(page.locator('.engine-setup')).toContainText('Running');
  expect((await nativeWorkspace(page)).engineUrl).toBe('http://127.0.0.1:9999');
  expect((await nativeWorkspace(page)).engineMode).toBe('manual');
  expect((await calls(page)).filter((call) => call.command === 'engine_connect')).toHaveLength(0);
});

test('invalid existing engine addresses do not change the active endpoint or manual preference', async ({
  page,
}) => {
  await nativeSetup(page, { savedSources: saved, readyOnMount: true });
  await openSetup(page);
  await expect
    .poll(
      async () => (await calls(page)).filter((call) => call.command === 'engine_connect').length,
    )
    .toBe(1);
  const address = await existingEngine(page);
  for (const url of [
    'file:///tmp/engine',
    'https://key@host/v1',
    'https://host/v1?key=secret',
    'https://host/v1#fragment',
  ]) {
    await address.fill(url);
    await page.getByRole('button', { name: 'Connect engine', exact: true }).click();
    await expect(page.locator('[data-tour="engine"]').getByRole('alert')).toBeVisible();
    expect((await nativeWorkspace(page)).engineUrl).toBe('http://127.0.0.1:8787');
    expect((await nativeWorkspace(page)).engineMode).toBe('local');
  }
  expect((await calls(page)).filter((call) => call.command === 'engine_connect')).toHaveLength(1);
});

test('a late explicit local start cannot replace a manually connected engine', async ({ page }) => {
  await nativeSetup(page, { savedSources: saved, pendingStart: true, holdStartReady: true });
  await openSetup(page);
  await page
    .locator('.engine-setup')
    .getByRole('button', { name: 'Start local engine', exact: true })
    .click();
  const address = await existingEngine(page);
  await address.fill('http://127.0.0.1:9999');
  await page.getByRole('button', { name: 'Connect engine', exact: true }).click();
  await expect.poll(async () => (await nativeWorkspace(page)).engineMode).toBe('manual');
  await page.evaluate(() =>
    (window as unknown as { releaseNativeStart: () => void }).releaseNativeStart(),
  );
  await expect(page.locator('.engine-setup')).toContainText('Running');
  expect((await nativeWorkspace(page)).engineUrl).toBe('http://127.0.0.1:9999');
  expect(
    (await calls(page))
      .filter((call) => call.command === 'engine_connect')
      .map((call) => call.args.url),
  ).toEqual(['http://127.0.0.1:9999']);
});

test('using the local engine is an explicit way to leave a manual connection', async ({ page }) => {
  await nativeSetup(page, { savedSources: saved, readyOnMount: true });
  await openSetup(page);
  const address = await existingEngine(page);
  await address.fill('http://127.0.0.1:9999');
  await page.getByRole('button', { name: 'Connect engine', exact: true }).click();
  await expect.poll(async () => (await nativeWorkspace(page)).engineMode).toBe('manual');
  await page
    .locator('.engine-setup')
    .getByRole('button', { name: 'Use local engine', exact: true })
    .click();
  await expect.poll(async () => (await nativeWorkspace(page)).engineMode).toBe('local');
  expect((await nativeWorkspace(page)).engineUrl).toBe('http://127.0.0.1:8787');
  expect(
    (await calls(page)).filter((call) => call.command === 'desktop_engine_start'),
  ).toHaveLength(0);
});

for (const locale of ['en', 'ru'] as const)
  test(`${locale} existing engine form fits the minimum native window in both themes`, async ({
    page,
  }, testInfo) => {
    const t: Record<string, string> = JSON.parse(
      readFileSync(`src/locales/${locale}.json`, 'utf8'),
    );
    await nativeSetup(page, { savedSources: saved });
    await page.addInitScript(
      (locale) =>
        Object.defineProperty(navigator, 'language', {
          value: locale === 'ru' ? 'ru-RU' : 'en-US',
        }),
      locale,
    );
    await page.setViewportSize({ width: 1000, height: 680 });
    await page.goto('/');
    await page.getByRole('button', { name: t['navigation.settings'], exact: true }).click();
    const card = page.locator('[data-tour="engine"]');
    await expect(card).not.toHaveAttribute('open');
    await card.locator('summary').click();
    const address = card.getByRole('textbox', { name: t['resources.engineBaseUrl'], exact: true });
    await address.fill('https://long-engine-address.example.org/teams/research/workflows');
    await expect(
      card.getByRole('button', { name: t['resources.saveAddress'], exact: true }),
    ).toHaveCount(0);
    for (const theme of ['dark', 'light']) {
      if (theme === 'light')
        await page.getByRole('radio', { name: t['resources.light'], exact: true }).click();
      await card.scrollIntoViewIfNeeded();
      const fits = await card.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          document.documentElement.scrollWidth <= innerWidth &&
          [...element.querySelectorAll('input,button')].every((control) => {
            const rect = control.getBoundingClientRect();
            return rect.left >= bounds.left && rect.right <= bounds.right + 1;
          })
        );
      });
      expect(fits).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`existing-engine-${locale}-${theme}-1000.png`),
      });
    }
  });
