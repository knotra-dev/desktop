import { readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { stringify } from 'yaml';
import { activeWorkspace, openActiveEditor, pipelineAction } from './authoring';

const longVersion = `2026.10.21-preview.${'long-release-channel-'.repeat(6)}`;

const labels: Record<'en' | 'ru', Record<string, string>> = {
  en: JSON.parse(readFileSync('src/locales/en.json', 'utf8')),
  ru: JSON.parse(readFileSync('src/locales/ru.json', 'utf8')),
};

async function open(
  page: Page,
  {
    locale = 'en',
    long = false,
    compact = false,
    tour = false,
  }: {
    locale?: 'en' | 'ru';
    long?: boolean;
    compact?: boolean;
    tour?: boolean;
  } = {},
) {
  const files = Array.from({ length: long ? 120 : 1 }, (_, index) => ({
    path: `notes/file_${index}.txt`,
    content: Buffer.from(`Preserved package bytes ${index}\n`).toString('base64'),
  }));
  const source = stringify({
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: {
      name: 'editor-header',
      title: long
        ? 'Research and publication workflow — Проверка источников, согласование и выпуск материалов'
        : 'Header workflow',
      version: long && locale === 'ru' ? longVersion : '1.2.3',
    },
    spec: {
      files: files.map((file) => file.path),
      models: { writer: { connection: 'model_main' } },
      nodes: {
        answer: {
          type: 'llm',
          llm: { model: 'writer', prompt: { text: 'Return a concise answer.' } },
          outputs: { text: { schema: { type: 'string' } } },
        },
      },
      outputs: {
        answer: { schema: { type: 'string' }, bind: { from: 'nodes.answer.outputs.text' } },
      },
    },
  });
  const workspace = {
    id: 'editor-header',
    source: `${source}\n# Unsaved author note.\n`,
    savedSource: source,
    entrypoint: 'pipeline.yaml',
    files,
    updatedAt: '2026-10-21T00:00:00Z',
  };
  await page.addInitScript(
    ({ workspace, locale, compact, tour }) => {
      localStorage.setItem(
        'knotra.workspace.v1',
        JSON.stringify({
          version: 1,
          starterRevision: 5,
          workspaces: [workspace],
          runs: [],
          activeId: workspace.id,
          engineUrl: 'http://127.0.0.1:8787',
          compact,
          theme: 'dark',
          locale,
        }),
      );
      if (tour) {
        localStorage.removeItem('knotra.tour.v1');
        localStorage.setItem('knotra.tour.workspace.v1', workspace.id);
      }
    },
    { workspace, locale, compact, tour },
  );
  await page.goto('/');
  if (!tour) await page.locator('.pipeline-card').first().click();
}

async function focusedControl(page: Page) {
  return page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    role: document.activeElement?.getAttribute('role'),
    label: document.activeElement?.getAttribute('aria-label'),
  }));
}

test('pipeline actions support keyboard navigation, dismissal and focus restoration', async ({
  page,
}, testInfo) => {
  await open(page);
  const trigger = page.getByRole('button', { name: 'Pipeline actions', exact: true });
  const menu = page.getByRole('menu');
  const first = menu.getByRole('menuitem', { name: 'Export', exact: true });
  const last = menu.getByRole('menuitem', { name: 'Delete pipeline', exact: true });
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  for (const key of ['Enter', 'Space', 'ArrowDown']) {
    await trigger.focus();
    await trigger.press(key);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toHaveAttribute('id', (await trigger.getAttribute('aria-controls'))!);
    await expect(first).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(last).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(first).toBeFocused();
    await page.keyboard.press('End');
    await expect(last).toBeFocused();
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await trigger.press('ArrowUp');
  await expect(last).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(trigger).not.toBeFocused();

  const forwardFocus = await focusedControl(page);
  await trigger.click();
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toHaveCount(0);
  await expect(trigger).not.toBeFocused();

  const reverseFocus = await focusedControl(page);
  await trigger.click();
  const instructions = page.getByRole('textbox', { name: 'Instructions', exact: true });
  await instructions.click();
  await expect(menu).toHaveCount(0);
  await expect(instructions).toBeFocused();
  await trigger.focus();
  await page.keyboard.press('Tab');
  const nativeForwardFocus = await focusedControl(page);
  await trigger.focus();
  await page.keyboard.press('Shift+Tab');
  const nativeReverseFocus = await focusedControl(page);
  const focusPath = testInfo.outputPath('native-tab-focus.json');
  writeFileSync(
    focusPath,
    JSON.stringify({ forwardFocus, reverseFocus, nativeForwardFocus, nativeReverseFocus }),
  );
  await testInfo.attach('native-tab-focus.json', {
    path: focusPath,
    contentType: 'application/json',
  });
  expect(forwardFocus).toEqual(nativeForwardFocus);
  expect(reverseFocus).toEqual(nativeReverseFocus);
});

test('menu export preserves current package bytes and deletion still requires confirmation', async ({
  page,
}) => {
  await open(page);
  const before = await activeWorkspace(page);
  const download = page.waitForEvent('download');
  await pipelineAction(page, 'Export');
  const archive = unzipSync(new Uint8Array(readFileSync((await (await download).path())!)));
  expect(Buffer.from(archive[before.entrypoint]).toString()).toBe(before.source);
  for (const file of before.files)
    expect(Buffer.from(archive[file.path])).toEqual(Buffer.from(file.content, 'base64'));
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pipeline actions', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.workspace-title')).toContainText('Saved locally');
  await expect(page.locator('.title-unsaved')).toHaveCount(0);
  await pipelineAction(page, 'Delete pipeline');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep pipeline', exact: true }).click();
  expect((await activeWorkspace(page)).source).toBe(before.source);
  await pipelineAction(page, 'Delete pipeline');
  await page.getByRole('button', { name: 'Remove pipeline', exact: true }).click();
  await expect(page.locator('.sidebar-pipelines > button')).toHaveCount(0);
});

test('closing pipeline actions with Escape leaves the interactive tour active', async ({
  page,
}) => {
  await open(page, { tour: true });
  const guide = page.getByRole('region', { name: 'Knotra tour', exact: true });
  await guide.getByRole('button', { name: 'Continue learning pipeline', exact: true }).click();
  await expect(guide).toContainText('2 of 8');

  const trigger = page.getByRole('button', { name: 'Pipeline actions', exact: true });
  await trigger.click();
  await expect(page.getByRole('menu').getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(guide).toContainText('2 of 8');
});

for (const locale of ['en', 'ru'] as const)
  for (const width of [1000, 1440])
    test(`${locale} editor header stays usable with a long title at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1000 ? 680 : 940 });
      await open(page, { locale, long: true, compact: width === 1000 });
      const t = labels[locale];
      const editor = page.locator('.workspace-view');
      const header = editor.locator('header').first();
      const tabs = page.getByRole('tablist', { name: t['editor.pipelineView'], exact: true });
      await expect(editor.getByRole('heading', { level: 1 })).toContainText(
        'Research and publication',
      );
      await expect(editor.locator('.title-unsaved')).toBeVisible();
      await expect(editor.locator('.title-unsaved')).toHaveAttribute('aria-hidden', 'true');
      await expect(header.locator('.workspace-title [aria-live="polite"]')).toContainText(
        t['editor.unsavedDraft'],
      );
      await expect(header).toContainText(locale === 'ru' ? longVersion : 'v1.2.3');
      if (locale === 'ru')
        await expect(header.locator('.heading-version')).toHaveAttribute(
          'title',
          `v${longVersion}`,
        );
      await expect(
        tabs.getByRole('tab', { name: new RegExp(`^${t['editor.files']} `) }),
      ).toContainText('121');

      const fits = await header.evaluate((element) => {
        const bounds = element.closest('.workspace-view')!.getBoundingClientRect();
        const controls = [
          ...element
            .closest('.workspace-view')!
            .querySelectorAll('.workspace-header button, .workspace-toolbar button'),
        ]
          .filter(
            (button) =>
              button.getClientRects().length && button.getAttribute('role') !== 'menuitem',
          )
          .map((button) => button.getBoundingClientRect());
        const title = element.querySelector('h1')!.getBoundingClientRect();
        const version = element.querySelector('.heading-version')!.getBoundingClientRect();
        const actions = element.lastElementChild!.getBoundingClientRect();

        return {
          page: document.documentElement.scrollWidth <= innerWidth,
          title: title.right <= version.left + 1 && version.right <= actions.left + 1,
          controls: controls.every(
            (rect) => rect.left >= bounds.left && rect.right <= bounds.right + 1,
          ),
          overlap: controls.some((left, index) =>
            controls
              .slice(index + 1)
              .some(
                (right) =>
                  Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 &&
                  Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1,
              ),
          ),
        };
      });

      expect(fits).toEqual({ page: true, title: true, controls: true, overlap: false });
      await page.screenshot({ path: testInfo.outputPath(`editor-header-${locale}-${width}.png`) });
      const actions = page.getByRole('button', {
        name: locale === 'ru' ? 'Действия с пайплайном' : 'Pipeline actions',
        exact: true,
      });
      await actions.click();
      const menu = page.getByRole('menu');
      await expect(
        menu.getByRole('menuitem', { name: t['common.export'], exact: true }),
      ).toBeVisible();

      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(width === 1000 ? 680 : 940);
      await page.screenshot({ path: testInfo.outputPath(`editor-actions-${locale}-${width}.png`) });
      await page.keyboard.press('Escape');
      for (const key of ['editor.code', 'editor.files', 'editor.canvas']) {
        const tab = tabs.getByRole('tab', { name: new RegExp(`^${t[key]}(?: |$)`) });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(
          editor.getByRole('button', { name: t['common.save'], exact: true }),
        ).toBeVisible();
        await expect(editor.locator('[data-tour="run"]')).toBeVisible();
        if (key !== 'editor.canvas') {
          await expect(
            editor.getByRole('button', { name: t['editor.workflow'], exact: true }),
          ).toHaveCount(0);
          await expect(editor.locator('[data-tour="add-node"]')).toHaveCount(0);
        }
      }
      await expect(
        editor.getByRole('button', { name: t['editor.workflow'], exact: true }),
      ).toBeVisible();
      await expect(editor.locator('[data-tour="add-node"]')).toBeVisible();
      if (width === 1000)
        await page.getByRole('button', { name: t['shell.expandNavigation'], exact: true }).click();
      await page.getByRole('button', { name: t['navigation.settings'], exact: true }).click();
      await page.getByRole('radio', { name: t['resources.light'], exact: true }).click();
      await openActiveEditor(page);
      await page.screenshot({
        path: testInfo.outputPath(`editor-header-${locale}-${width}-light.png`),
      });
      await actions.click();
      await expect(menu).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`editor-actions-${locale}-${width}-light.png`),
      });
    });
