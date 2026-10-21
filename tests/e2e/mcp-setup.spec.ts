import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { McpTool, SavedMcpConnection } from '../../src/lib/setup';

const tools: McpTool[] = [
  {
    name: 'search',
    title: 'Search documents',
    description: 'Find documents in your connected library.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'fetch',
    title: 'Read document',
    description: 'Read the content of one document.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
];
const saved: SavedMcpConnection = {
  id: 'mcp_saved',
  title: 'Research library',
  transport: 'streamable_http',
  url: 'https://library.example.test/mcp',
  tools,
  allowedTools: ['search'],
  hasCredential: true,
  revision: 1,
};
type Scenario = {
  servers?: SavedMcpConnection[];
  locale?: 'en' | 'ru';
  theme?: 'dark' | 'light';
  discoverErrorOnce?: boolean;
  saveErrorOnce?: boolean;
  holdDiscovery?: boolean;
};

async function open(page: Page, scenario: Scenario = {}) {
  await page.addInitScript(
    ({ scenario, tools }) => {
      const target = window as unknown as {
        mcpCalls: { command: string; args: Record<string, unknown> }[];
        releaseMcpDiscovery: () => void;
      };
      target.mcpCalls = [];
      let servers: SavedMcpConnection[] =
        JSON.parse(sessionStorage.getItem('mcp.fixture.servers') ?? 'null') ??
        scenario.servers ??
        [];
      let discoveryAttempts = 0;
      let saveAttempts = 0;
      const released = scenario.holdDiscovery
        ? new Promise<void>((resolve) => {
            target.releaseMcpDiscovery = resolve;
          })
        : Promise.resolve();
      const persist = () => sessionStorage.setItem('mcp.fixture.servers', JSON.stringify(servers));
      const fresh = {
        version: 1,
        starterRevision: 5,
        workspaces: [],
        runs: [],
        engineUrl: 'http://127.0.0.1:8787',
        engineMode: 'local',
        compact: false,
        theme: scenario.theme ?? 'dark',
        locale: scenario.locale ?? 'en',
      };
      Object.assign(window, {
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: 'main' } },
          transformCallback: () => 1,
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            target.mcpCalls.push({ command, args });
            if (command === 'workspace_load')
              return JSON.parse(
                sessionStorage.getItem('mcp.fixture.workspace') ?? JSON.stringify(fresh),
              );
            if (command === 'workspace_save') {
              sessionStorage.setItem('mcp.fixture.workspace', JSON.stringify(args.value));
              return;
            }
            if (command === 'desktop_setup_status')
              return {
                phase: 'idle',
                configured: false,
                sourcesState: 'current',
                connections: [],
                mcpConnections: servers,
              };
            if (command === 'desktop_connections_list') return [];
            if (command === 'desktop_mcp_connections_list') return servers;
            if (command === 'desktop_mcp_tools') {
              await released;
              if (scenario.discoverErrorOnce && ++discoveryAttempts === 1)
                throw `Cannot connect with ${args.token}`;

              return tools;
            }
            if (command === 'desktop_mcp_connection_save') {
              if (scenario.saveErrorOnce && ++saveAttempts === 1) throw `Cannot save ${args.token}`;

              const before = servers.find((server) => server.id === args.id);
              const server: SavedMcpConnection = {
                id: String(args.id ?? `mcp_${servers.length + 1}`),
                title: String(args.title),
                transport: 'streamable_http',
                url: new URL(String(args.url)).href,
                tools,
                allowedTools: args.allowedTools as string[],
                hasCredential: args.clearToken ? false : !!args.token || !!before?.hasCredential,
                revision: (before?.revision ?? 0) + 1,
              };
              servers = [...servers.filter((item) => item.id !== server.id), server];
              persist();

              return server;
            }
            if (command === 'desktop_mcp_connection_refresh') {
              const before = servers.find((server) => server.id === args.id)!;
              const server = {
                ...before,
                tools: [
                  ...tools,
                  { name: 'new_tool', title: 'New tool', inputSchema: { type: 'object' } },
                ],
                revision: before.revision + 1,
              };
              servers = servers.map((item) => (item.id === server.id ? server : item));
              persist();

              return server;
            }
            if (command === 'desktop_mcp_connection_remove') {
              servers = servers.filter((server) => server.id !== args.id);
              persist();
              return servers;
            }
            if (command === 'engine_cache') return { cache: {}, pending: [] };

            return 1;
          },
        },
      });
    },
    { scenario, tools },
  );
  await page.goto('/');
  const t: Record<string, string> = JSON.parse(
    readFileSync(`src/locales/${scenario.locale ?? 'en'}.json`, 'utf8'),
  );
  await page.getByRole('button', { name: t['navigation.settings'], exact: true }).click();
  await expect(page.locator('#mcp-settings')).toBeVisible();
  await expect(
    page.locator('#mcp-settings').getByRole('button', { name: t['mcpSetup.add'], exact: true }),
  ).toBeEnabled();

  return t;
}

function form(page: Page) {
  return page.locator('#mcp-settings');
}

async function calls(page: Page, command: string) {
  return page.evaluate(
    (command) =>
      (
        window as unknown as { mcpCalls: { command: string; args: Record<string, unknown> }[] }
      ).mcpCalls
        .filter((call) => call.command === command)
        .map((call) => call.args),
    command,
  );
}

async function add(page: Page) {
  await form(page).getByRole('button', { name: 'Add server', exact: true }).click();
  await form(page).getByRole('textbox', { name: 'Server name', exact: true }).fill('My tools');
  await form(page)
    .getByRole('textbox', { name: /^MCP server URL/ })
    .fill('https://tools.example.test/mcp');
}

test('adds a server after explicit tool permissions and keeps metadata across reopen without tokens', async ({
  page,
}) => {
  await open(page);
  await add(page);
  const url = form(page).getByRole('textbox', { name: /^MCP server URL/ });
  const discover = form(page).getByRole('button', { name: 'Connect and load tools', exact: true });
  await url.fill('https://user:pass@tools.example.test/mcp?token=unsafe');
  await expect(discover).toBeDisabled();
  await url.fill('https://tools.example.test/mcp');
  await form(page).locator('input[type="password"]').fill('secret-never-in-workspace');
  await discover.click();
  await expect(form(page).getByRole('checkbox', { name: /Search documents/ })).not.toBeChecked();
  await expect(form(page).getByRole('button', { name: 'Save server', exact: true })).toBeDisabled();
  await form(page)
    .getByRole('checkbox', { name: /Search documents/ })
    .check();
  await form(page).getByRole('button', { name: 'Save server', exact: true }).click();
  await expect(
    form(page).getByRole('button', { name: 'Edit My tools', exact: true }),
  ).toBeVisible();
  expect(await calls(page, 'desktop_mcp_connection_save')).toEqual([
    {
      title: 'My tools',
      url: 'https://tools.example.test/mcp',
      token: 'secret-never-in-workspace',
      allowedTools: ['search'],
    },
  ]);
  expect(await calls(page, 'desktop_engine_start')).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('mcp.fixture.workspace'))).not.toContain(
    'secret-never-in-workspace',
  );
  expect(await page.evaluate(() => localStorage.getItem('knotra.workspace.v1'))).toBeNull();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await form(page).getByRole('button', { name: 'Edit My tools', exact: true }).click();
  await expect(form(page).locator('input[type="password"]')).toHaveValue('');
  await expect(form(page).locator('input[type="password"]')).toHaveAttribute(
    'placeholder',
    'Saved token',
  );
  await expect(form(page).getByRole('checkbox', { name: /Search documents/ })).toBeChecked();
  await expect(form(page).getByRole('checkbox', { name: /Read document/ })).not.toBeChecked();
});

test('retains a saved token at the same URL and requires an explicit choice at a new URL', async ({
  page,
}) => {
  await open(page, { servers: [saved] });
  await form(page).getByRole('button', { name: 'Edit Research library', exact: true }).click();
  await form(page)
    .getByRole('textbox', { name: 'Server name', exact: true })
    .fill('Renamed library');
  await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await calls(page, 'desktop_mcp_connection_save')).at(-1)).toEqual({
    id: saved.id,
    expectedRevision: 1,
    title: 'Renamed library',
    url: saved.url,
    allowedTools: ['search'],
  });
  await form(page).getByRole('button', { name: 'Edit Renamed library', exact: true }).click();
  await form(page)
    .getByRole('textbox', { name: /^MCP server URL/ })
    .fill('https://other.example.test/mcp');
  await expect(form(page)).toContainText(
    'For a new address, re-enter the token or choose Remove saved token.',
  );
  await expect(
    form(page).getByRole('button', { name: 'Connect and load tools', exact: true }),
  ).toBeDisabled();
  await form(page).getByRole('checkbox', { name: 'Remove saved token', exact: true }).check();
  await expect(form(page).locator('input[type="password"]')).toBeDisabled();
  await form(page).getByRole('button', { name: 'Connect and load tools', exact: true }).click();
  expect((await calls(page, 'desktop_mcp_tools')).at(-1)).toEqual({
    id: saved.id,
    url: 'https://other.example.test/mcp',
    clearToken: true,
  });
  await expect(form(page).getByRole('checkbox', { name: /Search documents/ })).not.toBeChecked();
  await form(page)
    .getByRole('checkbox', { name: /Read document/ })
    .check();
  await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await calls(page, 'desktop_mcp_connection_save')).at(-1)).toEqual({
    id: saved.id,
    expectedRevision: 2,
    title: 'Renamed library',
    url: 'https://other.example.test/mcp',
    clearToken: true,
    allowedTools: ['fetch'],
  });
});

test('refresh never enables newly discovered tools and missing grants remain removable', async ({
  page,
}) => {
  await open(page, { servers: [{ ...saved, allowedTools: ['search', 'retired_tool'] }] });
  await form(page)
    .getByRole('button', { name: 'Refresh tools for Research library', exact: true })
    .click();
  await expect(
    form(page).getByRole('button', { name: 'Edit Research library', exact: true }),
  ).toBeEnabled();
  expect(await calls(page, 'desktop_mcp_connection_refresh')).toEqual([
    { id: saved.id, expectedRevision: 1 },
  ]);
  await form(page).getByRole('button', { name: 'Edit Research library', exact: true }).click();
  await expect(
    form(page).getByRole('checkbox', { name: 'New tool', exact: true }),
  ).not.toBeChecked();
  await form(page)
    .getByRole('checkbox', { name: /retired_tool.*No longer available/ })
    .click();
  await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await calls(page, 'desktop_mcp_connection_save')).at(-1)?.allowedTools).toEqual([
    'search',
  ]);
  expect((await calls(page, 'desktop_mcp_connection_save')).at(-1)?.expectedRevision).toBe(2);
  await form(page).getByRole('button', { name: 'Remove Research library', exact: true }).click();
  await expect(
    form(page).getByRole('button', { name: 'Edit Research library', exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, 'desktop_mcp_connection_remove')).toEqual([
    { id: saved.id, expectedRevision: 3 },
  ]);
});

test('a replacement token is sent explicitly for a different server address', async ({ page }) => {
  await open(page, { servers: [saved] });
  await form(page).getByRole('button', { name: 'Edit Research library', exact: true }).click();
  await form(page)
    .getByRole('textbox', { name: /^MCP server URL/ })
    .fill('https://new.example.test/mcp');
  await form(page).locator('input[type="password"]').fill('replacement-token');
  await form(page).getByRole('button', { name: 'Connect and load tools', exact: true }).click();
  expect((await calls(page, 'desktop_mcp_tools')).at(-1)).toEqual({
    id: saved.id,
    url: 'https://new.example.test/mcp',
    token: 'replacement-token',
  });
  await form(page)
    .getByRole('checkbox', { name: /Search documents/ })
    .check();
  await form(page).getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await calls(page, 'desktop_mcp_connection_save')).at(-1)).toEqual({
    id: saved.id,
    expectedRevision: 1,
    title: saved.title,
    url: 'https://new.example.test/mcp',
    token: 'replacement-token',
    allowedTools: ['search'],
  });
});

test('discovery and save failures redact supplied tokens and allow a retry', async ({ page }) => {
  await open(page, { discoverErrorOnce: true, saveErrorOnce: true });
  await add(page);
  await form(page).locator('input[type="password"]').fill('secret-error-token');
  await form(page).getByRole('button', { name: 'Connect and load tools', exact: true }).click();
  await expect(form(page).getByRole('alert')).toHaveText('Cannot connect with …');
  await expect(form(page).getByRole('alert')).not.toContainText('secret-error-token');
  await form(page).getByRole('button', { name: 'Connect and load tools', exact: true }).click();
  await form(page)
    .getByRole('checkbox', { name: /Search documents/ })
    .check();
  await form(page).getByRole('button', { name: 'Save server', exact: true }).click();
  await expect(form(page).getByRole('alert')).toHaveText('Cannot save …');
  await form(page).getByRole('button', { name: 'Save server', exact: true }).click();
  await expect(
    form(page).getByRole('button', { name: 'Edit My tools', exact: true }),
  ).toBeVisible();
});

test('cancel invalidates pending discovery and clears the unsaved token and form', async ({
  page,
}) => {
  await open(page, { holdDiscovery: true });
  await add(page);
  await form(page).locator('input[type="password"]').fill('discard-me');
  await form(page).getByRole('button', { name: 'Connect and load tools', exact: true }).click();
  await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { releaseMcpDiscovery: () => void }).releaseMcpDiscovery(),
  );
  await expect(form(page).getByRole('region', { name: 'Enabled tools', exact: true })).toHaveCount(
    0,
  );
  await form(page).getByRole('button', { name: 'Add server', exact: true }).click();
  await expect(form(page).getByRole('textbox', { name: 'Server name', exact: true })).toHaveValue(
    '',
  );
  await expect(form(page).locator('input[type="password"]')).toHaveValue('');
  expect(await calls(page, 'desktop_mcp_connection_save')).toEqual([]);
});

for (const locale of ['en', 'ru'] as const)
  for (const theme of ['dark', 'light'] as const)
    test(`${locale} MCP settings fit the native window in ${theme} theme`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1000, height: 780 });
      const t = await open(page, { servers: [saved], locale, theme });
      await form(page)
        .getByRole('button', {
          name: t['mcpSetup.edit'].replace('{name}', saved.title),
          exact: true,
        })
        .click();
      await expect(
        form(page).getByRole('button', { name: t['mcpSetup.saveChanges'], exact: true }),
      ).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (process.env.KNOTRA_MCP_VISUALS === '1') {
        await form(page)
          .getByRole('button', { name: t['mcpSetup.saveChanges'], exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath(`mcp-settings-${locale}-${theme}-bottom-1000.png`),
        });
      }
    });
