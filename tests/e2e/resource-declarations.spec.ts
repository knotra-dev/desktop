import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { parse, stringify } from 'yaml';
import type { Resource } from '../../src/lib/engine/types';
import type { SavedConnection, SavedMcpConnection } from '../../src/lib/setup';
import { type Graph, type Pipeline, record } from '../../src/lib/types';
import { activeWorkspace } from './authoring';

const models: SavedConnection[] = [
  {
    id: 'private_api_source',
    title: 'Work API',
    provider: 'openai',
    models: [
      { id: 'vendor/draft-pro', name: 'Draft model' },
      { id: 'vendor/reasoning', name: 'Reasoning model' },
    ],
    defaultModel: 'vendor/draft-pro',
    hasCredential: true,
  },
];
const mcp: SavedMcpConnection[] = [
  {
    id: 'private_mcp_source',
    title: 'Team library',
    transport: 'streamable_http',
    url: 'https://tools.example.test/mcp',
    tools: [{ name: 'search', title: 'Search documents', inputSchema: { type: 'object' } }],
    allowedTools: ['search'],
    hasCredential: true,
    revision: 1,
  },
];
const catalog: Resource[] = [
  {
    id: models[0].id,
    kind: 'model',
    title: `local / ${models[0].id}`,
    status: 'available',
    capabilities: [],
  },
  {
    id: mcp[0].id,
    kind: 'mcp',
    title: `local / ${mcp[0].id}`,
    status: 'available',
    capabilities: ['search'],
  },
  ...['python_box', 'node_box'].map(
    (id): Resource => ({
      id,
      title: `local / ${id}`,
      kind: 'sandbox',
      status: 'available',
      capabilities: ['files.read', 'files.write', 'process.exec'],
    }),
  ),
];

function definition(): Pipeline {
  const pipeline: Pipeline = parse(
    readFileSync(
      'vendor/engine/contracts/v1/fixtures/positive/artifact-mount/pipeline.yaml',
      'utf8',
    ),
  );
  pipeline.metadata = { name: 'resource-setup', title: 'Team document pipeline' };
  pipeline.spec.models = {
    writer: { connection: models[0].id, model: models[0].models[0].id },
  };
  pipeline.spec.mcp = { library: { connection: mcp[0].id } };
  pipeline.spec.nodes.copy_file = structuredClone(pipeline.spec.nodes.write_file);
  pipeline.spec.nodes.write_draft = {
    type: 'llm',
    llm: { model: 'writer', prompt: { text: 'Write a useful draft.' } },
    outputs: { text: { schema: { type: 'string' } } },
  };
  pipeline.spec.nodes.second_draft = structuredClone(pipeline.spec.nodes.write_draft);
  pipeline.spec.nodes.lookup = {
    type: 'tool',
    tool: { server: 'library', name: 'search', arguments: { value: {} }, response: 'content' },
    outputs: { result: { schema: { type: 'array', items: { type: 'object' } } } },
  };
  return pipeline;
}

async function open(
  page: Page,
  {
    locale = 'en',
    theme = 'dark',
    connected = true,
    pipeline = definition(),
    resources = catalog,
  }: {
    locale?: 'en' | 'ru';
    theme?: 'dark' | 'light';
    connected?: boolean;
    pipeline?: Pipeline;
    resources?: Resource[];
  } = {},
) {
  const source = stringify(pipeline);
  const workspace = {
    id: 'resource-setup',
    source,
    savedSource: source,
    entrypoint: 'pipeline.yaml',
    files: [],
    updatedAt: '2026-10-21T00:00:00Z',
  };
  await page.addInitScript(
    ({ workspace, locale, theme, models, mcp, connected, resources }) => {
      const state = {
        version: 1,
        starterRevision: 5,
        workspaces: [workspace],
        runs: [],
        activeId: workspace.id,
        engineUrl: 'http://127.0.0.1:8787',
        engineMode: 'local',
        compact: false,
        theme,
        locale,
      };
      Object.assign(window, {
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: 'main' } },
          transformCallback: () => 1,
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            if (command === 'workspace_load')
              return JSON.parse(
                localStorage.getItem('knotra.workspace.v1') ?? JSON.stringify(state),
              );
            if (command === 'workspace_save') {
              localStorage.setItem('knotra.workspace.v1', JSON.stringify(args.value));
              return;
            }
            if (command === 'desktop_connections_list') return models;
            if (command === 'desktop_mcp_connections_list') return mcp;
            if (command === 'desktop_setup_status')
              return {
                phase: connected ? 'ready' : 'idle',
                endpoint: connected ? state.engineUrl : undefined,
                configured: true,
                connections: models,
                mcpConnections: mcp,
                sourcesState: 'current',
                engineGeneration: 1,
                dockerReady: true,
                runtimeAvailable: true,
                codexAvailable: true,
                claudeAvailable: true,
              };
            if (command === 'engine_connect')
              return {
                protocol: 'knotra.desktop/1',
                engineId: 'resource-fixture',
                principalId: 'operator',
                version: 'fixture',
                capabilities: ['resources', 'profiles'],
              };
            if (command === 'engine_cache') return { cache: {}, pending: [] };
            if (command === 'engine_call') {
              const call = args.call as { op: string };
              if (call.op === 'resources') return { items: resources, nextCursor: null };
              if (call.op === 'profiles')
                return {
                  items: [{ id: 'local', title: 'Local environment', revision: 'fixture' }],
                };
              return { items: [], nextCursor: null };
            }
            return 1;
          },
        },
      });
    },
    { workspace, models, mcp, connected, resources, locale, theme },
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const t: Record<string, string> = JSON.parse(readFileSync(`src/locales/${locale}.json`, 'utf8'));
  await page
    .getByRole('navigation', { name: t['navigation.main'], exact: true })
    .getByRole('button', { name: t['navigation.resources'], exact: true })
    .click();
  await expect(page.locator('[data-resource-node="write_draft"]')).toBeVisible();
  return { t, errors };
}

async function pipeline(page: Page): Promise<Pipeline> {
  return parse((await activeWorkspace(page)).source);
}

for (const [locale, theme] of [
  ['en', 'dark'],
  ['ru', 'light'],
] as const)
  test(`${locale} ${theme} resource assignments show real selections and open their block`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1000, height: 760 });
    const { t, errors } = await open(page, { locale, theme });
    const usage = page.locator('.resource-usage');
    await expect(usage).toContainText('Work API');
    await expect(usage).toContainText('Draft model');
    expect(
      await usage.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const tabs = document.querySelector('.resource-tabs')!.getBoundingClientRect();
        return Math.abs(bounds.left - tabs.left) <= 1 && Math.abs(bounds.right - tabs.right) <= 1;
      }),
    ).toBe(true);
    for (const raw of ['writer', 'private_api_source', 'library', 'python_box'])
      await expect(usage).not.toContainText(raw);
    const advanced = page.locator('.resource-bindings');
    await expect(advanced).not.toHaveAttribute('open', '');
    await expect(advanced.locator('pre')).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`resource-assignments-${locale}-${theme}-1000.png`),
      fullPage: true,
    });
    await usage.locator('[data-resource-node="write_draft"]').getByRole('button').click();
    const model = page.locator('[data-tour="node-model"]');
    await expect(
      model.getByRole('combobox', { name: t['editor.modelSource'], exact: true }),
    ).toHaveValue(models[0].id);
    await expect(
      model.getByRole('combobox', { name: t['modelSetup.model'], exact: true }),
    ).toHaveValue('vendor/draft-pro');
    await expect(
      model.getByRole('combobox', { name: t['editor.modelSource'], exact: true }),
    ).toBeInViewport();
    await expect(
      model.getByRole('combobox', { name: t['modelSetup.model'], exact: true }),
    ).toBeInViewport();
    await expect(page.getByTestId('rf__node-write_draft').locator('p')).not.toContainText('writer');
    await expect(page.locator('.workflow-resources')).not.toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`resource-model-block-${locale}-${theme}-1000.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });

test('advanced bindings explain legacy aliases without making them the setup path', async ({
  page,
}) => {
  const { t, errors } = await open(page);
  const source = (await activeWorkspace(page)).source;
  const advanced = page.locator('.resource-bindings');
  await advanced.locator('summary').click();
  await expect(advanced.locator('pre')).toContainText('writer');
  await expect(advanced.locator('pre')).toContainText('private_api_source');
  await advanced
    .getByRole('button', { name: t['resources.editPipelineResources'], exact: true })
    .click();
  const declarations = page.locator('.workflow-resources > details');
  await expect(declarations).toHaveAttribute('open', '');
  await expect(
    page.getByRole('combobox', { name: 'writer · connection ID', exact: true }),
  ).toBeVisible();
  expect((await activeWorkspace(page)).source).toBe(source);
  expect(errors).toEqual([]);
});

test('MCP assignments name the server and tool and lead to server settings', async ({ page }) => {
  const { t, errors } = await open(page);
  await page
    .locator('.resource-tabs')
    .getByRole('button', { name: t['resources.mcpTools'], exact: true })
    .click();
  const usage = page.locator('.resource-usage');
  await expect(usage).toContainText('Team library');
  await expect(usage).toContainText('Search documents');
  await expect(usage).not.toContainText('private_mcp_source');
  await page.getByRole('button', { name: t['editor.connectMcp'], exact: true }).click();
  await expect(page.locator('#mcp-settings')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a nested assignment opens and changes only its own block', async ({ page }) => {
  const value = definition();
  const nested: Pipeline = parse(
    readFileSync('vendor/engine/contracts/v1/fixtures/positive/foreach/pipeline.yaml', 'utf8'),
  );
  const outer = nested.spec.nodes.review_all;
  const body = record(outer.foreach).body as Graph;
  const review = structuredClone(body.nodes.review);
  review.type = 'llm';
  review.llm = { model: 'writer', prompt: { text: 'Review this topic.' } };
  delete review.human;
  body.nodes.second_review = review;
  value.spec.nodes.review_all = outer;
  value.spec.inputs = { ...value.spec.inputs, ...nested.spec.inputs };
  const { t, errors } = await open(page, { pipeline: value });
  await page.locator('[data-resource-node="review_all/second_review"]').getByRole('button').click();
  await expect(page.locator('.inspector h2')).toHaveText('second review');
  await page
    .locator('[data-tour="node-model"]')
    .getByRole('combobox', { name: t['modelSetup.model'], exact: true })
    .selectOption('vendor/reasoning');
  await expect
    .poll(async () => {
      const changed = await pipeline(page);
      const nestedReview = (record(changed.spec.nodes.review_all.foreach).body as Graph).nodes
        .second_review;
      return changed.spec.models![String(record(nestedReview.llm).model)]?.model;
    })
    .toBe('vendor/reasoning');
  const changed = await pipeline(page);
  expect(changed.spec.nodes.write_draft).toEqual(value.spec.nodes.write_draft);
  expect(changed.spec.models!.writer).toEqual(value.spec.models!.writer);
  expect((record(changed.spec.nodes.review_all.foreach).body as Graph).nodes.review).toEqual(
    body.nodes.review,
  );
  expect(errors).toEqual([]);
});

test('code blocks select an environment without changing shared blocks or mounted inputs', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  const original = definition();
  const { t, errors } = await open(page, { pipeline: original });
  await page
    .locator('.resource-tabs')
    .getByRole('button', { name: new RegExp(t['resources.sandboxes']) })
    .click();
  const usage = page.locator('.resource-usage');
  await expect(usage).toContainText(t['resources.pythonSandbox']);
  await expect(usage).not.toContainText('python_box');
  await usage.locator('[data-resource-node="write_file"]').getByRole('button').click();
  const environment = page.getByRole('combobox', {
    name: t['editor.sandboxEnvironment'],
    exact: true,
  });
  await expect(environment).toHaveValue('python_box');
  await expect(environment.locator('option')).toContainText([
    t['resources.pythonSandbox'],
    t['resources.nodeSandbox'],
  ]);
  await environment.selectOption('node_box');
  await expect
    .poll(async () => {
      const value = await pipeline(page);
      return value.spec.sandboxes![value.spec.nodes.write_file.sandbox!]?.profile;
    })
    .toBe('node_box');
  const changed = await pipeline(page);
  expect(changed.spec.nodes.copy_file).toEqual(original.spec.nodes.copy_file);
  expect(changed.spec.sandboxes!.work).toEqual(original.spec.sandboxes!.work);
  expect({ ...changed.spec.nodes.write_file, sandbox: 'work' }).toEqual(
    original.spec.nodes.write_file,
  );
  await page.screenshot({
    path: testInfo.outputPath('resource-code-block-en-dark.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test('saved assignments remain readable offline and are never silently changed', async ({
  page,
}) => {
  const { t, errors } = await open(page, { connected: false });
  const source = (await activeWorkspace(page)).source;
  await expect(page.locator('.resource-usage')).toContainText('Work API');
  await expect(page.locator('.resource-usage')).toContainText('Draft model');
  await page
    .locator('.resource-tabs')
    .getByRole('button', { name: new RegExp(t['resources.sandboxes']) })
    .click();
  await page.locator('[data-resource-node="write_file"]').getByRole('button').click();
  const environment = page.getByRole('combobox', {
    name: t['editor.sandboxEnvironment'],
    exact: true,
  });
  await expect(environment).toHaveValue('python_box');
  await expect(environment.locator('option:checked')).toContainText(t['resources.pythonSandbox']);
  expect((await activeWorkspace(page)).source).toBe(source);
  expect(errors).toEqual([]);
});

test('agent file and command permissions preserve its MCP tools and shared environment', async ({
  page,
}) => {
  const original = definition();
  original.spec.nodes.assistant = {
    type: 'agent',
    sandbox: 'work',
    agent: { model: 'writer', prompt: { text: 'Review the document.' }, maxSteps: 3 },
    tools: { inherit: false, mcp: { library: ['search'] }, sandbox: ['files.read'] },
    outputs: { text: { schema: { type: 'string' } } },
  };
  const { t, errors } = await open(page, { pipeline: original });
  await page
    .locator('.resource-tabs')
    .getByRole('button', { name: t['resources.sandboxes'], exact: true })
    .click();
  await page.locator('[data-resource-node="assistant"]').getByRole('button').click();
  const panel = page.locator('[data-tour="node-sandbox"]');
  await expect(
    panel.getByRole('checkbox', { name: t['resources.readFiles'], exact: true }),
  ).toBeChecked();
  await panel.getByRole('checkbox', { name: t['resources.writeFiles'], exact: true }).check();
  await expect
    .poll(async () => (await pipeline(page)).spec.nodes.assistant.tools)
    .toEqual({
      inherit: false,
      mcp: { library: ['search'] },
      sandbox: ['files.read', 'files.write'],
    });
  await panel.getByRole('checkbox', { name: t['resources.readFiles'], exact: true }).uncheck();
  await expect
    .poll(async () => (await pipeline(page)).spec.nodes.assistant.tools)
    .toEqual({
      inherit: false,
      mcp: { library: ['search'] },
      sandbox: ['files.write'],
    });
  const changed = await pipeline(page);
  expect(changed.spec.sandboxes).toEqual(original.spec.sandboxes);
  expect(changed.spec.nodes.write_file).toEqual(original.spec.nodes.write_file);
  expect(errors).toEqual([]);
});

test('a missing environment stays selected and visible until the user chooses a replacement', async ({
  page,
}) => {
  const { t, errors } = await open(page, {
    resources: catalog.filter((item) => item.id !== 'python_box'),
  });
  const source = (await activeWorkspace(page)).source;
  await page
    .locator('.resource-tabs')
    .getByRole('button', { name: new RegExp(t['resources.sandboxes']) })
    .click();
  await page.locator('[data-resource-node="write_file"]').getByRole('button').click();
  const environment = page.getByRole('combobox', {
    name: t['editor.sandboxEnvironment'],
    exact: true,
  });
  await expect(environment).toHaveValue('python_box');
  await expect(environment.locator('option:checked')).toContainText(t['resources.pythonSandbox']);
  expect((await activeWorkspace(page)).source).toBe(source);
  expect(errors).toEqual([]);
});
