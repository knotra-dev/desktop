import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { parse, stringify } from 'yaml';
import type { SavedConnection } from '../../src/lib/setup';
import { type Graph, type Pipeline, record } from '../../src/lib/types';
import { activeWorkspace, openActiveEditor } from './authoring';

const sources: SavedConnection[] = [
  {
    id: 'api_source',
    title: 'My API',
    provider: 'openai',
    models: [
      { id: 'api/fast', name: 'Fast' },
      { id: 'api/reasoning', name: 'Reasoning' },
    ],
    defaultModel: 'api/fast',
    hasCredential: true,
  },
  {
    id: 'codex_source',
    title: 'Codex account',
    provider: 'codex',
    models: [{ id: 'codex/code', name: 'Code' }],
    defaultModel: 'codex/code',
    hasCredential: true,
  },
  {
    id: 'claude_source',
    title: 'Claude account',
    provider: 'claude',
    models: [{ id: 'claude/reasoning', name: 'Claude reasoning' }],
    defaultModel: 'claude/reasoning',
    hasCredential: true,
  },
  {
    id: 'api_other',
    title: 'Other API key',
    provider: 'openai',
    models: [{ id: 'api/fast', name: 'Fast' }],
    defaultModel: 'api/fast',
    hasCredential: true,
  },
];

async function open(
  page: Page,
  {
    delayed = false,
    catalog = sources,
    model = 'api/fast',
  }: {
    delayed?: boolean;
    catalog?: SavedConnection[];
    model?: string;
  } = {},
) {
  const pipeline: Pipeline = {
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: { name: 'per-node-models' },
    spec: {
      models: {},
      nodes: {
        answer: {
          type: 'llm',
          llm: { model: 'writer', prompt: { text: 'Answer the question.' } },
          outputs: { text: { schema: { type: 'string' } } },
        },
      },
      outputs: {
        text: { schema: { type: 'string' }, bind: { from: 'nodes.answer.outputs.text' } },
      },
    },
  };
  pipeline.spec.models!.writer = {
    connection: 'api_source',
    ...(model ? { model } : {}),
    requires: ['structuredOutput'],
    parameters: { temperature: 0.2 },
  };
  pipeline.spec.nodes.other = structuredClone(pipeline.spec.nodes.answer);
  const agent = structuredClone(pipeline.spec.nodes.answer);
  agent.type = 'agent';
  agent.sandbox = 'work';
  agent.agent = { ...record(agent.llm), maxSteps: 3 };
  delete agent.llm;
  pipeline.spec.nodes.agent = agent;
  pipeline.spec.sandboxes = { work: { profile: 'python_box' } };
  const nested: Pipeline = parse(
    readFileSync('vendor/engine/contracts/v1/fixtures/positive/foreach/pipeline.yaml', 'utf8'),
  );
  const outer = nested.spec.nodes.review_all;
  const body = record(outer.foreach).body as Graph;
  const review = body.nodes.review;
  review.type = 'llm';
  review.llm = { model: 'writer', prompt: { text: 'Review the topic.' } };
  delete review.human;
  pipeline.spec.nodes.review_all = outer;
  pipeline.spec.inputs = { ...pipeline.spec.inputs, ...nested.spec.inputs };
  const source = stringify(pipeline);
  const workspace = {
    id: 'per-node-models',
    source,
    savedSource: source,
    entrypoint: 'pipeline.yaml',
    files: [],
    updatedAt: '2026-10-21T00:00:00Z',
  };
  const state = {
    version: 1,
    starterRevision: 5,
    workspaces: [workspace],
    runs: [],
    activeId: workspace.id,
    engineUrl: 'http://127.0.0.1:8787',
    compact: false,
    theme: 'dark',
    locale: 'en',
  };
  await page.addInitScript(
    ({ stateJson, sources, delayed }) => {
      const target = window as unknown as {
        isTauri: boolean;
        __TAURI_INTERNALS__: unknown;
        __TAURI_EVENT_PLUGIN_INTERNALS__: unknown;
        nativeCommands: string[];
        releaseSources: () => void;
      };
      target.isTauri = true;
      target.nativeCommands = [];
      target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      const ready = delayed
        ? new Promise<void>((resolve) => {
            target.releaseSources = resolve;
          })
        : Promise.resolve();
      target.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          target.nativeCommands.push(command);
          if (command === 'workspace_load')
            return JSON.parse(localStorage.getItem('knotra.workspace.v1') ?? stateJson);
          if (command === 'workspace_save') {
            localStorage.setItem('knotra.workspace.v1', JSON.stringify(args.value));
            return;
          }
          if (command === 'desktop_connections_list') {
            await ready;
            return sources;
          }
          if (command === 'desktop_setup_status')
            return {
              phase: 'idle',
              configured: true,
              connections: sources,
              dockerReady: true,
              runtimeAvailable: true,
              codexAvailable: true,
              claudeAvailable: true,
            };
          if (command === 'engine_cache') return { cache: {}, pending: [] };
          return 1;
        },
      };
    },
    { stateJson: JSON.stringify(state), sources: catalog, delayed },
  );
  await page.goto('/');
  await openActiveEditor(page);
  await expect(page.getByText('Local checks passed', { exact: true })).toBeVisible();
  await expect(page.locator('[data-tour="node-model"] input')).toHaveCount(0);
}

async function node(page: Page, id: string) {
  await page.getByTestId(`rf__node-${id}`).click();
  return page.locator('[data-tour="node-model"]');
}

async function selection(page: Page, id: string): Promise<Record<string, unknown>> {
  const value: Pipeline = parse((await activeWorkspace(page)).source);
  const node = value.spec.nodes[id];
  return value.spec.models![String(record(node[node.type]).model)];
}

test('each model block chooses from all saved sources while the engine is stopped', async ({
  page,
}, testInfo) => {
  await open(page);
  let panel = await node(page, 'answer');
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveValue(
    'api_source',
  );
  await expect(
    panel.getByRole('combobox', { name: 'Source', exact: true }).locator('option'),
  ).toHaveText(['My API', 'Codex account', 'Claude account', 'Other API key']);
  await panel.getByRole('combobox', { name: 'Model', exact: true }).selectOption('api/reasoning');
  await expect
    .poll(() => selection(page, 'answer'))
    .toEqual({
      connection: 'api_source',
      model: 'api/reasoning',
      requires: ['structuredOutput'],
      parameters: { temperature: 0.2 },
    });
  expect(await selection(page, 'other')).toEqual({
    connection: 'api_source',
    model: 'api/fast',
    requires: ['structuredOutput'],
    parameters: { temperature: 0.2 },
  });
  panel = await node(page, 'agent');
  await panel.getByRole('combobox', { name: 'Source', exact: true }).selectOption('codex_source');
  await panel.getByRole('combobox', { name: 'Model', exact: true }).selectOption('codex/code');
  await expect
    .poll(() => selection(page, 'agent'))
    .toMatchObject({
      connection: 'codex_source',
      model: 'codex/code',
    });
  panel = await node(page, 'other');
  await panel.getByRole('combobox', { name: 'Source', exact: true }).selectOption('claude_source');
  await panel
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('claude/reasoning');
  await expect
    .poll(() => selection(page, 'other'))
    .toMatchObject({
      connection: 'claude_source',
      model: 'claude/reasoning',
    });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await openActiveEditor(page);
  panel = await node(page, 'answer');
  await expect(panel.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'api/reasoning',
  );
  panel = await node(page, 'agent');
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveValue(
    'codex_source',
  );
  await expect(panel.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'codex/code',
  );
  const commands = await page.evaluate(
    () => (window as unknown as { nativeCommands: string[] }).nativeCommands,
  );
  expect(commands).not.toContain('desktop_engine_start');
  expect(commands).not.toContain('engine_connect');
  await page.setViewportSize({ width: 1000, height: 680 });
  await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('node-model-picker-dark.png') });
});

test('two sources from the same provider route identical model IDs independently', async ({
  page,
}) => {
  await open(page);
  const panel = await node(page, 'answer');
  await panel.getByRole('combobox', { name: 'Source', exact: true }).selectOption('api_other');
  await expect(
    panel.getByRole('combobox', { name: 'Model', exact: true }).locator('option'),
  ).toHaveText(['Use provider default · api/fast', 'Fast · api/fast']);
  await panel.getByRole('combobox', { name: 'Model', exact: true }).selectOption('api/fast');
  await expect
    .poll(() => selection(page, 'answer'))
    .toMatchObject({
      connection: 'api_other',
      model: 'api/fast',
    });
  expect(await selection(page, 'other')).toMatchObject({
    connection: 'api_source',
    model: 'api/fast',
  });
});

test('nested blocks select fetched models without changing their parent model', async ({
  page,
}) => {
  await open(page);
  await node(page, 'review_all');
  await page.getByRole('button', { name: 'Edit body graph', exact: true }).click();
  const panel = page.locator('[data-tour="node-model"]');
  await panel.getByRole('combobox', { name: 'Model', exact: true }).selectOption('api/reasoning');
  await expect
    .poll(async () => {
      const value: Pipeline = parse((await activeWorkspace(page)).source);
      const body = record(value.spec.nodes.review_all.foreach).body as Graph;
      return value.spec.models![String(record(body.nodes.review.llm).model)];
    })
    .toMatchObject({ connection: 'api_source', model: 'api/reasoning' });
  expect((await selection(page, 'answer')).model).toBe('api/fast');
  await page.getByRole('button', { name: 'Parent graph', exact: true }).click();
  await node(page, 'answer');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('api/fast');
});

test('a source catalog arriving later never rewrites the saved model selection', async ({
  page,
}) => {
  await open(page, { delayed: true });
  const panel = await node(page, 'answer');
  const model = panel.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toBeDisabled();
  await expect(model).toHaveValue('api/fast');
  const before = (await activeWorkspace(page)).source;
  await page.evaluate(() => (window as unknown as { releaseSources: () => void }).releaseSources());
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('api/fast');
  expect((await activeWorkspace(page)).source).toBe(before);
  await expect(panel.locator('input')).toHaveCount(0);
});

test('a missing source guides setup without a model ID field or a draft mutation', async ({
  page,
}) => {
  await open(page, { catalog: [], model: '' });
  const panel = await node(page, 'answer');
  const before = (await activeWorkspace(page)).source;
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveValue(
    'api_source',
  );
  await expect(panel.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
  await expect(panel).toContainText('Choose a saved source to see its models.');
  await expect(panel.locator('input')).toHaveCount(0);
  expect((await activeWorkspace(page)).source).toBe(before);
  await panel.getByRole('button', { name: 'Manage model sources', exact: true }).click();
  await expect(page.locator('.model-setup')).toBeVisible();
});

test('saved models absent from a refreshed catalog remain read-only until a fetched model is chosen', async ({
  page,
}) => {
  await open(page, { model: 'api/legacy-private' });
  const panel = await node(page, 'answer');
  const model = panel.getByRole('combobox', { name: 'Model', exact: true });
  const before = (await activeWorkspace(page)).source;
  await expect(model).toHaveValue('api/legacy-private');
  await expect(model.locator('option[value="api/legacy-private"]')).toHaveAttribute('disabled', '');
  expect((await activeWorkspace(page)).source).toBe(before);
  await expect(panel.locator('input')).toHaveCount(0);
  await model.selectOption('api/reasoning');
  await expect.poll(() => selection(page, 'answer')).toMatchObject({ model: 'api/reasoning' });
  expect((await selection(page, 'other')).model).toBe('api/legacy-private');
});

test('an empty saved catalog offers its provider default and a source refresh action', async ({
  page,
}) => {
  await open(page, { catalog: [{ ...sources[0], models: [] }] });
  const panel = await node(page, 'answer');
  await expect(panel).toContainText('No saved model list for this source.');
  const model = panel.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toHaveValue('api/fast');
  await expect(panel.locator('input')).toHaveCount(0);
  await model.selectOption('');
  await expect.poll(() => selection(page, 'answer')).toMatchObject({ connection: 'api_source' });
  expect((await selection(page, 'answer')).model).toBeUndefined();
  expect((await selection(page, 'other')).model).toBe('api/fast');
  await expect(
    panel.getByRole('button', { name: 'Manage model sources', exact: true }),
  ).toBeVisible();
});
