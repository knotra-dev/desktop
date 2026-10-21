import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { expect, type Page, test } from '@playwright/test';
import type { Profile, Resource } from '../../src/lib/engine/types';

let server: Server;
let endpoint = '';
const sourceId = 'source_c1abae75f2831362';
const catalog: Resource[] = [
  {
    id: sourceId,
    title: `local / ${sourceId}`,
    kind: 'model',
    status: 'available',
    capabilities: [],
  },
  {
    id: 'node_box',
    title: 'local / node_box',
    kind: 'sandbox',
    status: 'available',
    capabilities: ['files.read', 'files.write', 'process.exec'],
  },
  {
    id: 'python_box',
    title: 'local / python_box',
    kind: 'sandbox',
    status: 'available',
    capabilities: ['files.read', 'files.write', 'process.exec'],
  },
];
let resources = catalog;
let profiles: Profile[] = [];
function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(JSON.stringify(value));
}
test.beforeEach(async () => {
  resources = catalog;
  profiles = [{ id: 'local', title: 'Local profile', revision: 'fixture' }];
  server = createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Idempotency-Key,Last-Event-ID,Authorization',
      });
      response.end();
      return;
    }
    const path = new URL(request.url!, endpoint).pathname;
    if (path === '/v1/info')
      return json(response, {
        protocol: 'knotra.desktop/1',
        engineId: 'catalog-fixture',
        principalId: 'operator',
        version: 'fixture',
        capabilities: ['resources', 'profiles'],
      });
    if (path === '/v1/profiles') return json(response, { items: profiles });
    return json(response, { items: path === '/v1/resources' ? resources : [], nextCursor: null });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function openCatalog(
  page: Page,
  locale: 'en' | 'ru' = 'en',
  theme: 'dark' | 'light' = 'dark',
) {
  const t: Record<string, string> = JSON.parse(readFileSync(`src/locales/${locale}.json`, 'utf8'));
  await page.addInitScript(
    (locale) =>
      Object.defineProperty(navigator, 'language', { value: locale === 'ru' ? 'ru-RU' : 'en-US' }),
    locale,
  );
  await page.goto('/');
  await page.getByRole('button', { name: t['navigation.settings'], exact: true }).click();
  if (theme === 'light')
    await page.getByRole('radio', { name: t['resources.light'], exact: true }).click();
  await page
    .getByRole('textbox', { name: t['resources.engineBaseUrl'], exact: true })
    .fill(endpoint);
  await page.getByRole('button', { name: t['resources.connectEngine'], exact: true }).click();
  await expect(page.getByText('catalog-fixture', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: t['navigation.main'] })
    .getByRole('button', { name: t['navigation.resources'], exact: true })
    .click();
  await revealCatalog(page);
  return t;
}

async function revealCatalog(page: Page) {
  const details = page.locator('details').filter({ has: page.locator('.engine-connections') });
  if ((await details.getAttribute('open')) === null)
    await details.locator(':scope > summary').click();
}

async function nativeCatalog(page: Page, mode: 'local' | 'manual') {
  await page.addInitScript(
    ({ catalog, sourceId, mode }) => {
      const target = window as unknown as {
        isTauri: boolean;
        __TAURI_INTERNALS__: unknown;
      };
      target.isTauri = true;
      const sources = [
        {
          id: sourceId,
          title: 'My private work API',
          provider: 'openai',
          models: [{ id: 'fixture-model', name: 'Fixture model' }],
          hasCredential: true,
        },
      ];
      const info = {
        protocol: 'knotra.desktop/1',
        engineId: 'catalog-fixture',
        principalId: 'operator',
        version: 'fixture',
        capabilities: ['resources', 'profiles'],
      };
      target.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'workspace_load')
            return {
              version: 1,
              starterRevision: 5,
              workspaces: [],
              runs: [],
              activeId: '',
              engineUrl: 'http://127.0.0.1:8787',
              engineMode: mode,
              compact: false,
              theme: 'dark',
              locale: 'en',
            };
          if (command === 'desktop_connections_list') return sources;
          if (command === 'desktop_setup_status')
            return {
              phase: 'ready',
              endpoint: 'http://127.0.0.1:8787',
              configured: true,
              sourcesState: 'current',
              engineGeneration: 1,
              connections: sources,
              dockerReady: true,
              runtimeAvailable: true,
              codexAvailable: true,
              claudeAvailable: true,
            };
          if (command === 'engine_connect') return info;
          if (command === 'engine_cache') return { cache: {}, pending: [] };
          if (command === 'engine_call') {
            const call = args.call as { op: string };
            if (call.op === 'profiles')
              return { items: [{ id: 'local', title: 'Local profile', revision: 'fixture' }] };
            return { items: call.op === 'resources' ? catalog : [], nextCursor: null };
          }
          return 1;
        },
      };
    },
    { catalog, sourceId, mode },
  );
}

for (const locale of ['en', 'ru'] as const)
  for (const theme of ['dark', 'light'] as const)
    test(`${locale} ${theme} connections explain the user's three resources at minimum width`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1000, height: 720 });
      const t = await openCatalog(page, locale, theme);
      const section = page.locator('.engine-connections');
      const rows = section.locator('.engine-connection');
      await expect(rows).toHaveCount(3);
      for (const key of ['modelSource', 'nodeSandbox', 'pythonSandbox'])
        await expect(
          section.getByRole('heading', { name: t[`resources.${key}`], exact: true }),
        ).toBeVisible();
      await expect(section.getByText(t['resources.configured'], { exact: true })).toHaveCount(3);
      for (const key of ['readFiles', 'writeFiles', 'runCommands'])
        await expect(rows.nth(1)).toContainText(t[`resources.${key}`]);
      for (const raw of [
        sourceId,
        'node_box',
        'python_box',
        'local /',
        'files.read',
        'files.write',
        'process.exec',
        'available',
      ])
        await expect(section).not.toContainText(raw);
      const technical = section.getByRole('button', {
        name: t['resources.engineTechnicalDetails'],
        exact: true,
      });
      await expect(technical).toHaveAttribute('aria-expanded', 'false');
      await expect(section.locator('pre')).toHaveCount(0);
      await section.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          section.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const tabs = document.querySelector('.resource-tabs')!.getBoundingClientRect();
            return (
              Math.abs(bounds.left - tabs.left) <= 1 &&
              Math.abs(bounds.right - tabs.right) <= 1 &&
              document.documentElement.scrollWidth <= innerWidth &&
              element.scrollWidth <= element.clientWidth + 1 &&
              [...element.querySelectorAll('li,h3,button,span')].every((child) => {
                const rect = child.getBoundingClientRect();
                return rect.left >= bounds.left && rect.right <= bounds.right + 1;
              })
            );
          }),
        )
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`engine-connections-${locale}-${theme}-1000.png`),
        fullPage: true,
      });
      await technical.click();
      await expect(technical).toHaveAttribute('aria-expanded', 'true');
      for (const raw of [
        sourceId,
        'node_box',
        'python_box',
        'files.read',
        'files.write',
        'process.exec',
      ])
        await expect(section.locator('pre')).toContainText(raw);
      expect(errors).toEqual([]);
    });

test('friendly names and distinct profile entries survive without exposing connection IDs', async ({
  page,
}) => {
  profiles = [
    { id: 'local', title: 'Personal environment', revision: 'fixture' },
    { id: 'team_profile', title: 'Team environment', revision: 'fixture' },
  ];
  resources = [
    { ...catalog[0], title: 'Design studio' },
    { ...catalog[0], title: `team_profile / ${sourceId}` },
    { ...catalog[0], id: 'research_api', title: 'local / research_api', status: 'unavailable' },
    { ...catalog[1], capabilities: ['files.read', 'vendor.hidden_internal_capability'] },
  ];
  const t = await openCatalog(page);
  const section = page.locator('.engine-connections');
  const rows = section.locator('.engine-connection');
  await expect(rows).toHaveCount(4);
  await expect(
    rows.nth(0).getByRole('heading', { name: 'Design studio', exact: true }),
  ).toBeVisible();
  await expect(
    rows.nth(1).getByRole('heading', { name: t['resources.modelSource'], exact: true }),
  ).toBeVisible();
  await expect(rows.nth(1)).toContainText('Team environment');
  await expect(
    rows.nth(2).getByRole('heading', { name: 'Research api', exact: true }),
  ).toBeVisible();
  await expect(rows.nth(2)).toContainText('Personal environment');
  await expect(rows.nth(2)).toContainText(t['resources.needsSetup']);
  await expect(rows.nth(3)).toContainText(t['resources.readFiles']);
  for (const raw of [sourceId, 'team_profile', 'research_api', 'vendor.hidden_internal_capability'])
    await expect(section).not.toContainText(raw);
  await section
    .getByRole('button', { name: t['resources.engineTechnicalDetails'], exact: true })
    .click();
  await expect(section.locator('pre')).toContainText('vendor.hidden_internal_capability');
  await expect(section.locator('pre')).toContainText('team_profile');
});

test('an empty engine catalog explains the absence of connections', async ({ page }) => {
  resources = [];
  const t = await openCatalog(page);
  const section = page.locator('.engine-connections');
  await expect(section.locator('.engine-connection')).toHaveCount(0);
  await expect(section.getByRole('status')).toHaveText(t['resources.engineConnectionsEmpty']);
  await expect(
    section.getByRole('button', { name: t['resources.engineTechnicalDetails'], exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
});

test('the owned local engine uses the saved model source name', async ({ page }) => {
  await nativeCatalog(page, 'local');
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Resources', exact: true })
    .click();
  await revealCatalog(page);
  const section = page.locator('.engine-connections');
  await expect(
    section.getByRole('heading', { name: 'My private work API', exact: true }),
  ).toBeVisible();
  await expect(section).not.toContainText(sourceId);
});

for (const url of ['http://127.0.0.1:8787', 'http://127.0.0.1:8788'])
  test(`a manual engine at ${url} cannot inherit a private local source name`, async ({ page }) => {
    await nativeCatalog(page, 'manual');
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Engine base URL', exact: true });
    if (await input.isHidden()) await page.locator('[data-tour="engine"] summary').click();
    await input.fill(url);
    await page.getByRole('button', { name: 'Connect engine', exact: true }).click();
    await expect(page.getByText('catalog-fixture', { exact: true })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Resources', exact: true })
      .click();
    await revealCatalog(page);
    const section = page.locator('.engine-connections');
    await expect(section.getByRole('heading', { name: 'Model source', exact: true })).toBeVisible();
    await expect(section).not.toContainText('My private work API');
    await expect(section).not.toContainText(sourceId);
  });
