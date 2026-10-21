import { expect, type Page, test } from '@playwright/test';
import { parse, stringify } from 'yaml';
import { type Binding, type Pipeline, record } from '../../src/lib/types';
import { activeWorkspace, openActiveEditor } from './authoring';

function definition(argumentsBinding: Binding = { value: { query: 'Original query' } }): Pipeline {
  return {
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: { name: 'block-setup' },
    spec: {
      files: ['first.txt', 'second.txt'],
      inputs: { payload: { schema: { type: 'object' }, default: { query: 'Knotra' } } },
      models: { writer: { connection: 'model_main', parameters: { temperature: 0.2 } } },
      mcp: { search: { connection: 'search_remote' } },
      defaults: { tools: { mcp: { search: ['search'] } } },
      nodes: {
        answer: {
          type: 'llm',
          description: 'Notes for the workflow author.',
          llm: { model: 'writer', prompt: { text: 'Keep my original instructions.' } },
          outputs: { text: { schema: { type: 'string' } } },
        },
        other: {
          type: 'llm',
          llm: { model: 'writer', prompt: { text: 'A separate task.' } },
          outputs: { text: { schema: { type: 'string' } } },
        },
        review: {
          type: 'human',
          human: { prompt: { text: 'Review the result and return feedback.' } },
          outputs: { feedback: { schema: { type: 'string' } } },
        },
        lookup: {
          type: 'tool',
          inputs: { payload: { schema: { type: 'object' }, bind: { from: 'inputs.payload' } } },
          tool: {
            server: 'search',
            name: 'search',
            arguments: argumentsBinding,
            response: 'structured',
          },
          outputs: { result: { schema: { type: 'object' } } },
        },
      },
      outputs: {
        text: { schema: { type: 'string' }, bind: { from: 'nodes.answer.outputs.text' } },
      },
    },
  };
}

async function open(page: Page, pipeline = definition(), account = false) {
  const source = stringify(pipeline);
  const workspace = {
    id: 'block-setup',
    source,
    savedSource: source,
    entrypoint: 'pipeline.yaml',
    files: ['first.txt', 'second.txt'].map((path) => ({
      path,
      content: Buffer.from(`Instructions from ${path}`).toString('base64'),
    })),
    updatedAt: '2026-10-21T00:00:00Z',
  };
  await page.addInitScript(
    ({ workspace, account }) => {
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
      if (!localStorage.getItem('knotra.workspace.v1'))
        localStorage.setItem('knotra.workspace.v1', JSON.stringify(state));
      if (!account) return;
      Object.assign(window, {
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: 'main' } },
          transformCallback: () => 1,
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            if (command === 'workspace_load')
              return JSON.parse(localStorage.getItem('knotra.workspace.v1')!);
            if (command === 'workspace_save') {
              localStorage.setItem('knotra.workspace.v1', JSON.stringify(args.value));
              return;
            }
            if (command === 'desktop_connections_list')
              return [
                {
                  id: 'model_main',
                  title: 'My Codex',
                  provider: 'codex',
                  models: [{ id: 'default', name: 'Default' }],
                  hasCredential: false,
                },
              ];
            if (command === 'desktop_setup_status') return { phase: 'idle' };
            if (command === 'engine_cache') return { cache: {}, pending: [] };
            return 1;
          },
        },
      });
    },
    { workspace, account },
  );
  await page.goto('/');
  await openActiveEditor(page);
  await expect(page.getByText('Local checks passed', { exact: true })).toBeVisible();
}

async function pipeline(page: Page): Promise<Pipeline> {
  return parse((await activeWorkspace(page)).source);
}

async function select(page: Page, id: string) {
  await page.getByTestId(`rf__node-${id}`).click();
}

async function visitPorts(page: Page) {
  await page.getByRole('button', { name: 'Inputs & outputs', exact: true }).click();
  await page.getByRole('button', { name: 'Setup', exact: true }).click();
}

function disclosure(page: Page, label: string) {
  return page.locator('summary').filter({ hasText: new RegExp(`^${label}$`) });
}

async function model(page: Page, id: string) {
  const value = await pipeline(page);
  return value.spec.models![String(record(value.spec.nodes[id].llm).model)];
}

test('main task is visible while optional execution settings stay collapsed', async ({ page }) => {
  await open(page);
  await select(page, 'answer');
  const instructions = page.getByRole('textbox', { name: 'Instructions', exact: true });
  await expect(instructions).toHaveValue('Keep my original instructions.');
  await expect(instructions).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toBeVisible();
  await expect(page.locator('.inspector-content')).toContainText('does not affect execution');
  for (const label of ['Prompt source', 'System instructions', 'Model parameters'])
    await expect(disclosure(page, label).locator('..')).not.toHaveAttribute('open');
  await expect(
    page.getByRole('textbox', { name: 'System instructions', exact: true }),
  ).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Model parameters', exact: true })).toBeHidden();
  await disclosure(page, 'System instructions').click();
  const system = page.getByRole('textbox', { name: 'System instructions', exact: true });
  await system.fill('Keep responses concise.');
  await system.press('Tab');
  await expect
    .poll(async () => record((await pipeline(page)).spec.nodes.answer.llm).instructions)
    .toEqual({ text: 'Keep responses concise.' });
  await expect(instructions).toHaveValue('Keep my original instructions.');
  await select(page, 'review');
  await expect(page.getByRole('textbox', { name: 'Review request', exact: true })).toBeVisible();
});

test('switching prompt sources restores authored text and the selected package file', async ({
  page,
}) => {
  await open(page);
  await select(page, 'answer');
  const instructions = page.getByRole('textbox', { name: 'Instructions', exact: true });
  await instructions.fill('My edited instructions must survive source changes.');
  await instructions.press('Tab');
  await disclosure(page, 'Prompt source').click();
  const source = page.getByRole('combobox', { name: 'Prompt source', exact: true });
  await source.selectOption('file');
  const file = page.getByRole('combobox', { name: 'Prompt file', exact: true });
  await file.selectOption('second.txt');
  await visitPorts(page);
  await source.selectOption('text');
  await expect(instructions).toHaveValue('My edited instructions must survive source changes.');
  await visitPorts(page);
  if (await source.isHidden()) await disclosure(page, 'Prompt source').click();
  await source.selectOption('file');
  await expect(file).toHaveValue('second.txt');
  await expect
    .poll(async () => record((await pipeline(page)).spec.nodes.answer.llm).prompt)
    .toEqual({ file: 'second.txt' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await openActiveEditor(page);
  await select(page, 'answer');
  await expect(source).toBeVisible();
  await expect(file).toHaveValue('second.txt');
});

test('tool argument modes keep authored JSON and expressions and hide response format', async ({
  page,
}) => {
  await open(page);
  await select(page, 'lookup');
  const mode = page.getByRole('combobox', { name: 'Tool arguments', exact: true });
  const json = page.getByRole('textbox', { name: 'Arguments JSON', exact: true });
  const expression = page.getByRole('textbox', { name: 'Arguments expression', exact: true });
  await json.fill('{"query":"Keep this query","limit":7}');
  await json.press('Tab');
  await mode.selectOption('expr');
  await expression.fill('{"query": args.topic}');
  await expression.press('Tab');
  await visitPorts(page);
  await mode.selectOption('value');
  await expect(json).toHaveValue(JSON.stringify({ query: 'Keep this query', limit: 7 }, null, 2));
  await visitPorts(page);
  await mode.selectOption('expr');
  await expect(expression).toHaveValue('{"query": args.topic}');
  await expect
    .poll(async () => record((await pipeline(page)).spec.nodes.lookup.tool).arguments)
    .toEqual({ expr: '{"query": args.topic}' });
  const response = page.getByRole('combobox', { name: 'Response format', exact: true });
  await expect(response).toBeHidden();
  await disclosure(page, 'Response format').click();
  await response.selectOption('content');
  await expect
    .poll(async () => record((await pipeline(page)).spec.nodes.lookup.tool).response)
    .toBe('content');
});

for (const binding of [
  { from: 'args.payload' },
  { from: 'args.payload', path: '/nested' },
  { coalesce: [{ from: 'args.payload' }, { value: { query: 'Fallback' } }] },
] satisfies Binding[])
  test(`advanced tool binding is preserved without value wrapping: ${JSON.stringify(binding)}`, async ({
    page,
  }) => {
    await open(page, definition(binding));
    await select(page, 'lookup');
    await expect(page.getByRole('combobox', { name: 'Tool arguments', exact: true })).toHaveValue(
      'binding',
    );
    const before = record((await pipeline(page)).spec.nodes.lookup.tool).arguments;
    await page
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Updated author note.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect(record((await pipeline(page)).spec.nodes.lookup.tool).arguments).toEqual(before);
    expect(before).toEqual(binding);
    await page.reload();
    await openActiveEditor(page);
    await select(page, 'lookup');
    expect(record((await pipeline(page)).spec.nodes.lookup.tool).arguments).toEqual(binding);
  });

test('model parameters warn for account sources and reset only the current block', async ({
  page,
}, testInfo) => {
  await open(page, definition(), true);
  await select(page, 'answer');
  await disclosure(page, 'Model parameters').click();
  await expect(page.locator('.inspector-content')).toContainText(
    'Account sources do not accept API parameters.',
  );
  const parameters = page.getByRole('textbox', { name: 'Model parameters', exact: true });
  await parameters.fill('{"temperature":0.6,"maxTokens":128}');
  await parameters.press('Tab');
  await expect
    .poll(async () => (await model(page, 'answer')).parameters)
    .toEqual({ temperature: 0.6, maxTokens: 128 });
  expect((await model(page, 'other')).parameters).toEqual({ temperature: 0.2 });
  await page.getByRole('button', { name: 'Use source defaults', exact: true }).click();
  await expect.poll(async () => (await model(page, 'answer')).parameters).toBeUndefined();
  expect((await model(page, 'other')).parameters).toEqual({ temperature: 0.2 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await openActiveEditor(page);
  expect((await model(page, 'answer')).parameters).toBeUndefined();
  expect((await model(page, 'other')).parameters).toEqual({ temperature: 0.2 });
  if (process.env.KNOTRA_BLOCK_VISUALS !== '1') return;
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.reload();
  await openActiveEditor(page);
  for (const locale of ['en', 'ru']) {
    if (locale === 'ru') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ru');
      await openActiveEditor(page);
    }
    for (const id of ['answer', 'lookup']) {
      await select(page, id);
      await page.locator('.inspector-content').evaluate((element) => {
        element.scrollTop = 0;
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath(`block-${id}-${locale}-1000.png`) });
    }
    await page
      .getByRole('button', {
        name: locale === 'ru' ? 'Входы и выходы' : 'Inputs & outputs',
        exact: true,
      })
      .click();
    await page.locator('.inspector-content').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath(`ports-basic-${locale}-1000.png`) });
  }
});
