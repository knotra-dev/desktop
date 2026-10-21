import { expect, type Page, test } from '@playwright/test';
import { parse, stringify } from 'yaml';
import type { SavedMcpConnection } from '../../src/lib/setup';
import { type Pipeline, record } from '../../src/lib/types';
import { activeWorkspace, openActiveEditor } from './authoring';

const sources: SavedMcpConnection[] = [
  {
    id: 'saved_search',
    title: 'Research server',
    transport: 'streamable_http',
    url: 'https://tools.example.test/mcp',
    revision: 1,
    hasCredential: true,
    allowedTools: ['search', 'fetch', 'report'],
    tools: [
      {
        name: 'search',
        title: 'Search documents',
        description: 'Search the connected library.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: { type: 'string', title: 'Search query', description: 'Words to find.' },
            limit: { type: 'integer', title: 'Result limit', minimum: 1 },
          },
        },
      },
      {
        name: 'fetch',
        title: 'Read document',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            document: { type: 'string', title: 'Document' },
            limit: { type: 'integer', title: 'Result limit' },
          },
        },
      },
      { name: 'delete', title: 'Delete document', inputSchema: { type: 'object' } },
      {
        name: 'report',
        title: 'Structured report',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
          additionalProperties: false,
        },
      },
    ],
  },
];

function definition(): Pipeline {
  const call = {
    type: 'tool' as const,
    tool: {
      server: 'library',
      name: 'search',
      arguments: { value: { query: 'Before', extra: 'kept' } },
    },
    outputs: { result: { schema: { type: 'object' } } },
  };
  return {
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: { name: 'mcp-blocks' },
    spec: {
      models: { writer: { connection: 'model_main' } },
      mcp: { library: { connection: 'legacy_search' } },
      sandboxes: { work: { profile: 'python_box' } },
      defaults: { tools: { mcp: { library: ['search'] }, sandbox: ['files.read'] } },
      nodes: {
        lookup: call,
        other: structuredClone(call),
        research: {
          type: 'agent',
          sandbox: 'work',
          agent: { model: 'writer', prompt: { text: 'Research the topic.' }, maxSteps: 4 },
          tools: { mcp: { library: ['fetch'] }, sandbox: ['files.write'] },
          outputs: { text: { schema: { type: 'string' } } },
        },
      },
      outputs: {
        result: { schema: { type: 'object' }, bind: { from: 'nodes.lookup.outputs.result' } },
      },
    },
  };
}

async function open(page: Page, pipeline = definition()) {
  const source = stringify(pipeline);
  const workspace = {
    id: 'mcp-blocks',
    entrypoint: 'pipeline.yaml',
    source,
    savedSource: source,
    files: [],
    updatedAt: '2026-10-21T00:00:00Z',
  };
  await page.addInitScript(
    ({ workspace, sources }) => {
      const state = {
        version: 1,
        starterRevision: 5,
        workspaces: [workspace],
        runs: [],
        activeId: workspace.id,
        engineUrl: 'http://127.0.0.1:8787',
        engineMode: 'local',
        compact: false,
        theme: 'dark',
        locale: 'en',
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
            if (command === 'desktop_mcp_connections_list') return sources;
            if (command === 'desktop_connections_list') return [];
            if (command === 'desktop_setup_status')
              return { phase: 'idle', configured: false, mcpConnections: sources, connections: [] };
            if (command === 'engine_cache') return { cache: {}, pending: [] };
            return 1;
          },
        },
      });
    },
    { workspace, sources },
  );
  await page.goto('/');
  await openActiveEditor(page);
  await expect(page.getByText('Local checks passed', { exact: true })).toBeVisible();
}

async function pipeline(page: Page): Promise<Pipeline> {
  return parse((await activeWorkspace(page)).source);
}

test('tool blocks select saved servers and discovered allowed tools without changing shared resources', async ({
  page,
}, testInfo) => {
  await open(page);
  await page.getByTestId('rf__node-lookup').click();
  const server = page.getByRole('combobox', { name: 'MCP server', exact: true });
  await server.selectOption('saved_search');
  const tool = page.getByRole('combobox', { name: 'Tool name', exact: true });
  await expect(tool).toHaveValue('search');
  await expect(tool.getByRole('option', { name: 'Delete document', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'MCP server alias', exact: true })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Tool name', exact: true })).toBeHidden();
  const source = await pipeline(page);
  expect(record(source.spec.nodes.lookup.tool).server).toBe('lookup_mcp');
  await expect(page.getByTestId('rf__node-lookup').locator('.node-summary')).toHaveText('search');
  expect(source.spec.mcp!.lookup_mcp.connection).toBe('saved_search');
  expect(record(source.spec.nodes.lookup.tool).response).toBe('content');
  expect(source.spec.nodes.lookup.outputs!.result.schema).toEqual({
    type: 'array',
    items: { type: 'object' },
  });
  expect(record(source.spec.nodes.other.tool).server).toBe('library');
  expect(source.spec.mcp!.library.connection).toBe('legacy_search');
  expect(source.spec.defaults!.tools!.mcp).toEqual({ library: ['search'] });
  expect(source.spec.outputs).toEqual(definition().spec.outputs);
  await page.getByRole('textbox', { name: 'Search query', exact: true }).fill('Updated');
  await page.getByRole('spinbutton', { name: 'Result limit', exact: true }).fill('5');
  await expect
    .poll(async () => record(record((await pipeline(page)).spec.nodes.lookup.tool).arguments).value)
    .toEqual({ query: 'Updated', extra: 'kept', limit: 5 });
  if (process.env.KNOTRA_MCP_VISUALS === '1') {
    await page.setViewportSize({ width: 1000, height: 780 });
    await page.locator('.inspector-content').evaluate((element) => {
      element.scrollTop = 0;
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('mcp-tool-en-dark-1000.png') });
  }
  await tool.selectOption('fetch');
  await expect(page.getByRole('textbox', { name: 'Document', exact: true })).toBeVisible();
  expect(record(record((await pipeline(page)).spec.nodes.lookup.tool).arguments).value).toEqual({
    query: 'Updated',
    extra: 'kept',
    limit: 5,
  });
});

test('structured tools use their published schema while text-only tools keep content arrays', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('rf__node-lookup').click();
  await page
    .getByRole('combobox', { name: 'MCP server', exact: true })
    .selectOption('saved_search');
  const tool = page.getByRole('combobox', { name: 'Tool name', exact: true });
  await tool.selectOption('report');
  let value = await pipeline(page);
  expect(record(value.spec.nodes.lookup.tool).response).toBe('structured');
  expect(value.spec.nodes.lookup.outputs!.result.schema).toEqual(
    sources[0].tools.find((tool) => tool.name === 'report')!.outputSchema,
  );
  await tool.selectOption('search');
  value = await pipeline(page);
  expect(record(value.spec.nodes.lookup.tool).response).toBe('content');
  expect(value.spec.nodes.lookup.outputs!.result.schema).toEqual({
    type: 'array',
    items: { type: 'object' },
  });
  expect(value.spec.nodes.other).toEqual(definition().spec.nodes.other);
  expect(value.spec.outputs).toEqual(definition().spec.outputs);
});

test('custom result contracts stay intact until the author chooses the tool response format', async ({
  page,
}) => {
  const value = definition();
  value.spec.nodes.lookup.outputs = {
    result: {
      schema: {
        type: 'object',
        properties: { authored: { type: 'string' } },
        required: ['authored'],
      },
      description: 'Keep this authored description.',
    },
  };
  await open(page, value);
  await page.getByTestId('rf__node-lookup').click();
  await page
    .getByRole('combobox', { name: 'MCP server', exact: true })
    .selectOption('saved_search');
  expect((await pipeline(page)).spec.nodes.lookup.outputs).toEqual(value.spec.nodes.lookup.outputs);
  await page.getByRole('button', { name: 'Use tool response format', exact: true }).click();
  const after = await pipeline(page);
  expect(after.spec.nodes.lookup.outputs!.result).toEqual({
    schema: { type: 'array', items: { type: 'object' } },
    description: 'Keep this authored description.',
  });
  expect(record(after.spec.nodes.lookup.tool).response).toBe('content');
  expect(after.spec.nodes.other).toEqual(value.spec.nodes.other);
  expect(after.spec.outputs).toEqual(value.spec.outputs);
});

test('agents opt into individual tools and uncheck inherited tools without losing sandbox permissions', async ({
  page,
}) => {
  const value = definition();
  value.spec.mcp!.library.connection = 'saved_search';
  await open(page, value);
  await page.getByTestId('rf__node-research').click();
  const search = page.getByRole('checkbox', { name: /Search documents/ });
  const fetch = page.getByRole('checkbox', { name: /Read document/ });
  await expect(search).toBeChecked();
  await expect(fetch).toBeChecked();
  await search.uncheck();
  await expect
    .poll(async () => (await pipeline(page)).spec.nodes.research.tools)
    .toEqual({
      inherit: false,
      mcp: { library: ['fetch'] },
      sandbox: ['files.read', 'files.write'],
    });
  await fetch.uncheck();
  await expect
    .poll(async () => record((await pipeline(page)).spec.nodes.research.tools).mcp)
    .toEqual({});
  await search.check();
  await expect
    .poll(async () => record((await pipeline(page)).spec.nodes.research.tools).mcp)
    .toEqual({ library: ['search'] });
  await expect(page.getByRole('checkbox', { name: /Delete document/ })).toHaveCount(0);
});

test('removing unsupported fixed arguments is explicit and keeps compatible values and shared blocks', async ({
  page,
}) => {
  const value = definition();
  value.spec.mcp!.library.connection = 'saved_search';
  value.spec.nodes.lookup.tool = {
    server: 'library',
    name: 'search',
    arguments: {
      value: {
        query: 'Keep until removed',
        document: 'saved-document',
        limit: 3,
        obsolete: 'Remove me',
      },
    },
  };
  await open(page, value);
  await page.getByTestId('rf__node-lookup').click();
  await page.getByRole('combobox', { name: 'Tool name', exact: true }).selectOption('fetch');
  await expect(page.getByRole('textbox', { name: 'Document', exact: true })).toHaveValue(
    'saved-document',
  );
  await expect(page.locator('.inspector-content').getByRole('status')).toContainText(
    'query, obsolete',
  );
  expect(record(record((await pipeline(page)).spec.nodes.lookup.tool).arguments).value).toEqual({
    query: 'Keep until removed',
    document: 'saved-document',
    limit: 3,
    obsolete: 'Remove me',
  });
  await page.getByRole('button', { name: 'Remove unsupported fields', exact: true }).click();
  await expect
    .poll(async () => record(record((await pipeline(page)).spec.nodes.lookup.tool).arguments).value)
    .toEqual({ document: 'saved-document', limit: 3 });
  expect((await pipeline(page)).spec.nodes.other).toEqual(value.spec.nodes.other);
});

test('removed tools remain visible and removable and Settings is one action away', async ({
  page,
}) => {
  const value = definition();
  value.spec.mcp!.library.connection = 'saved_search';
  value.spec.nodes.research.tools = {
    inherit: false,
    mcp: { library: ['retired_tool'] },
    sandbox: ['process.exec'],
  };
  await open(page, value);
  await page.getByTestId('rf__node-research').click();
  await page.getByRole('checkbox', { name: /retired_tool.*unavailable/i }).click();
  await expect
    .poll(async () => (await pipeline(page)).spec.nodes.research.tools)
    .toEqual({ inherit: false, mcp: {}, sandbox: ['process.exec'] });
  await page
    .locator('.inspector-content')
    .getByRole('button', { name: 'Manage MCP servers', exact: true })
    .click();
  await expect(page.locator('#mcp-settings')).toBeVisible();
});
