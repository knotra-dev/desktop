import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { unzipSync, zipSync } from 'fflate';
import {
  activeWorkspace,
  addResearchPipeline,
  openActiveEditor,
  pipelineAction,
} from './authoring';

async function navigate(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();
}

async function open(page: Page) {
  await page.goto('/');
  await addResearchPipeline(page);
  await expect.poll(() => persisted(page)).not.toBeNull();
}

async function persisted(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('knotra.workspace.v1')!));
}

test('only one tab can write drafts and closing it releases the workspace', async ({
  page,
  context,
}) => {
  await open(page);
  const backup = await persisted(page);
  const other = await context.newPage();
  await other.goto('/');
  await expect(
    other.getByRole('heading', { name: 'Could not open the saved workspace' }),
  ).toBeVisible();
  await expect(
    other.getByText(
      'This workspace is already open in another browser tab. Close that tab and retry.',
    ),
  ).toBeVisible();

  await page
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Preserve the active tab edits');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  expect((await activeWorkspace(page)).source).toContain('Preserve the active tab edits');

  // A secondary tab must not bypass ownership through the recovery restore action.
  await other.getByLabel('Restore from a backup', { exact: true }).setInputFiles({
    name: 'stale-workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await other.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await other.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  expect((await activeWorkspace(page)).source).toContain('Preserve the active tab edits');

  await page.close();
  await other.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(other.locator('.pipelines-page')).toBeVisible();
  await openActiveEditor(other);
  await expect(other.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(
    'Preserve the active tab edits',
  );
});

test('unsupported workspace locking preserves browser data', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  await page.goto('/');
  await expect(
    page.getByText(
      'This browser cannot safely lock the workspace. Use a browser with Web Locks support.',
    ),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('knotra.workspace.v1'))).toBeNull();
});

test('unreadable workspace recovery keeps ownership while restoring a valid backup', async ({
  page,
}) => {
  await open(page);
  const backup = await persisted(page);
  await page.addInitScript(() => localStorage.setItem('knotra.workspace.v1', '{broken'));
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Could not open the saved workspace' }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('knotra.workspace.v1'))).toBe('{broken');
  await page.getByLabel('Restore from a backup', { exact: true }).setInputFiles({
    name: 'workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await expect(page.locator('.pipelines-page')).toBeVisible();
  expect(await persisted(page)).toEqual(backup);
});

test('authoring stays synchronized and navigation preference survives reload', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await open(page);
  await page
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Check the sources carefully');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect
    .poll(async () => (await activeWorkspace(page)).source.includes('Check the sources carefully'))
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toHaveCount(0);
  const expandedWidth = (await page.locator('.app-sidebar').boundingBox())!.width;
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  await expect
    .poll(async () => (await page.locator('.app-sidebar').boundingBox())!.width)
    .toBeLessThan(expandedWidth);
  await expect.poll(async () => (await persisted(page)).compact).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand navigation' }).click();
  await openActiveEditor(page);
  await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(
    'Check the sources carefully',
  );
  await navigate(page, 'Runs');
  await expect(page.getByRole('heading', { name: 'Engine runs', exact: true })).toBeVisible();
  await navigate(page, 'Inbox');
  await expect(
    page.getByRole('heading', { name: 'Needs your response', exact: true }),
  ).toBeVisible();
  await navigate(page, 'Artifacts');
  await expect(page.getByRole('heading', { name: 'Engine artifacts', exact: true })).toBeVisible();
  await navigate(page, 'Resources');
  await expect(page.getByRole('heading', { name: 'Models & tools' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Compact navigation' })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup' }).click();
  const backup = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
  expect(
    backup.workspaces.some((w: { source: string }) =>
      w.source.includes('Check the sources carefully'),
    ),
  ).toBe(true);
  expect(failures).toEqual([]);
});

test('complete ZIP package import preserves child contracts and every exported byte', async ({
  page,
}) => {
  await open(page);
  const root = resolve('vendor/engine/contracts/v1/fixtures/positive/subpipeline');
  const contents = Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = resolve(entry.parentPath, entry.name);
        return [path.slice(root.length + 1), new Uint8Array(readFileSync(path))];
      }),
  );
  await page.getByRole('button', { name: 'Open package', exact: true }).click();
  await page.getByLabel('Import pipeline package', { exact: true }).setInputFiles({
    name: 'subpipeline.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipSync(contents)),
  });
  const chooser = page.getByRole('dialog');
  await expect(chooser.getByRole('heading', { name: 'Choose the entrypoint.' })).toBeVisible();
  await chooser.getByRole('combobox').selectOption('pipeline.yaml');
  await chooser.getByRole('button', { name: 'Open package', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'subpipeline-contract', exact: true }),
  ).toBeVisible();
  await page.locator('.react-flow__node').first().click();
  await page.getByRole('button', { name: 'Inputs & outputs', exact: true }).click();
  await expect(
    page
      .locator('.inspector .port-editor-card')
      .filter({ has: page.locator('strong').filter({ hasText: /^reply$/ }) }),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await pipelineAction(page, 'Export');
  const exported = unzipSync(new Uint8Array(readFileSync((await (await download).path())!)));
  expect(Object.keys(exported).sort()).toEqual(Object.keys(contents).sort());
  for (const [path, bytes] of Object.entries(contents))
    expect(Buffer.from(exported[path]), path).toEqual(Buffer.from(bytes));
});

for (const theme of ['dark', 'light'] as const)
  test(`${theme} palette persists and keeps YAML and popups legible`, async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
      .click();
    await expect.poll(async () => (await persisted(page))?.theme).toBe(theme);
    await page.reload();
    await openActiveEditor(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator(`.react-flow.${theme}`)).toBeVisible();
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Pipeline YAML' });
    await editor.fill('# readable comment\nanswer: 12\napproved: true\nmessage: hello');
    await expect(page.locator('.knotra-scalar-number')).toHaveText('12');
    await expect(page.locator('.knotra-scalar-boolean')).toHaveText('true');
    const contrast = await page.locator('.cm-content span').evaluateAll((spans) => {
      const linear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      const luminance = (color: string) => {
        const rgb = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map((n) => linear(Number(n) / 255));
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      };
      const background = luminance(
        getComputedStyle(document.querySelector('.cm-editor')!).backgroundColor,
      );
      return spans.map((span) => {
        const foreground = luminance(getComputedStyle(span).color);
        return (
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        );
      });
    });
    expect(contrast.length).toBeGreaterThan(3);
    expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
    await expect.poll(async () => (await activeWorkspace(page)).source).toContain('answer: 12');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
      .focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      theme === 'dark' ? 'light' : 'dark',
    );
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await navigate(page, 'Pipelines');
    await openActiveEditor(page);
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Pipeline YAML' })).toContainText('answer: 12');
    await page.getByRole('button', { name: 'New pipeline', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

test('build and configure blocks with named ports, drag connections and workflow resources', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Add node', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Human review/ })
    .click();
  await expect(page.locator('.inspector h2')).toHaveText('human');
  await page.getByRole('button', { name: 'Inputs & outputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  await page.getByRole('textbox', { name: 'New input name', exact: true }).fill('brief');
  await page.getByRole('button', { name: 'Create port', exact: true }).click();
  await page.getByRole('button', { name: 'draft output brief', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'human input brief', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Source for brief', exact: true })).toHaveValue(
    'nodes.draft.outputs.brief',
  );
  await page.getByRole('button', { name: 'review output feedback', exact: true }).hover();
  const from = await page
    .getByRole('button', { name: 'review output feedback', exact: true })
    .boundingBox();
  const to = await page
    .getByRole('button', { name: 'human input brief', exact: true })
    .boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2 + 5, from!.y + from!.height / 2, { steps: 3 });
  await expect(page.locator('.react-flow__connection')).toHaveCount(1);
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(page.getByRole('combobox', { name: 'Source for brief', exact: true })).toHaveValue(
    'nodes.review.outputs.feedback',
  );
  await page.getByRole('button', { name: 'human output answer', exact: true }).click();
  await page.getByRole('button', { name: 'draft input summary', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('cycle');
  await page.getByRole('button', { name: 'discover output result', exact: true }).click();
  await page.getByRole('button', { name: 'human input brief', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('different data types');
  // Move a block without changing pipeline notation; remember its layout after reload.
  const originalPosition = (await activeWorkspace(page)).positions['::human'];
  const card = page.locator('.react-flow__node[data-id="human"] .flow-card-top');
  const before = await card.boundingBox();
  await page.mouse.move(before!.x + 70, before!.y + 10);
  await page.mouse.down();
  await page.mouse.move(before!.x + 90, before!.y + 35, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => (await activeWorkspace(page)).positions?.['::human'])
    .not.toEqual(originalPosition);
  const position = (await activeWorkspace(page)).positions['::human'];
  await page.getByRole('button', { name: 'Workflow', exact: true }).click();
  await page.getByText('Advanced resource bindings', { exact: true }).click();
  await page.getByText('Models (2)', { exact: true }).click();
  await page.getByRole('textbox', { name: 'New model alias', exact: true }).fill('assistant');
  await page.getByRole('textbox', { name: 'Connection ID', exact: true }).fill('local_model');
  await page.getByRole('button', { name: 'Add alias', exact: true }).click();
  await page.getByRole('textbox', { name: 'New workflow output', exact: true }).fill('reviewed');
  await page
    .getByRole('combobox', { name: 'Export from', exact: true })
    .selectOption('nodes.human.outputs.answer');
  await page.getByRole('button', { name: 'Add workflow output', exact: true }).click();
  await page.getByRole('button', { name: 'Add node', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^AI agent/ })
    .click();
  await expect(page.locator('.inspector h2')).toHaveText('agent');
  await page
    .locator('.setup-inspector summary')
    .filter({ hasText: /^Model alias$/ })
    .click();
  await page.getByRole('combobox', { name: /^Model alias/ }).selectOption('assistant');
  await page.getByRole('textbox', { name: /^Instructions/ }).fill('Summarize the supplied facts.');
  await page.getByRole('spinbutton', { name: /^Maximum model steps/ }).fill('7');
  const centers = await page.evaluate(() => {
    const dot = document.querySelector('.title-unsaved')!.getBoundingClientRect();
    const status = document
      .querySelector('.workspace-title [aria-live="polite"]')!
      .getBoundingClientRect();
    const logo = document.querySelector('.brand img')!.getBoundingClientRect();
    const toggle = document.querySelector('.nav-toggle')!.getBoundingClientRect();
    return {
      dot: Math.abs(dot.y + dot.height / 2 - status.y - status.height / 2),
      toggle: Math.abs(logo.y + logo.height / 2 - toggle.y - toggle.height / 2),
    };
  });
  expect(centers.dot).toBeLessThan(1);
  expect(centers.toggle).toBeLessThan(1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await activeWorkspace(page)).source).toContain('maxSteps: 7');
  const source = (await activeWorkspace(page)).source;
  expect(source).toContain('connection: local_model');
  expect(source).toContain('model: assistant');
  expect(source).toContain('from: nodes.review.outputs.feedback');
  expect(source).toContain('from: nodes.human.outputs.answer');
  await page.reload();
  await openActiveEditor(page);
  expect((await activeWorkspace(page)).positions['::human']).toEqual(position);
  await page.getByRole('button', { name: 'Workflow', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Source for reviewed', exact: true }),
  ).toHaveValue('nodes.human.outputs.answer');
});

test('configure a nested body and add blocks in its own scope', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'New pipeline', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Building blocks', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Parallel review / })
    .click();
  await page.getByRole('spinbutton', { name: /^Concurrent iterations/ }).fill('3');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Edit body graph', exact: true }).click();
  await expect(page.getByRole('button', { name: 'review input topic', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add node', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^AI agent/ })
    .click();
  await expect(page.locator('.inspector h2')).toHaveText('agent');
  await expect(
    page.getByRole('button', { name: 'agent input question', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Parent graph', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'review_all input items', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'agent input question', exact: true })).toHaveCount(
    0,
  );
  await expect
    .poll(
      async () =>
        (await persisted(page)).workspaces.find((w: { source: string }) =>
          w.source.includes('foreach-contract'),
        )?.source,
    )
    .toContain('concurrency: 3');
});

for (const theme of ['dark', 'light'] as const)
  test(`${theme} input sources stay stacked at desktop widths`, async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
      .click();
    await navigate(page, 'Pipelines');
    await openActiveEditor(page);
    await page.locator('.react-flow__node[data-id="draft"] .flow-card-top').click();
    await page.getByRole('button', { name: 'Inputs & outputs', exact: true }).click();
    for (const width of [1456, 1000]) {
      await page.setViewportSize({ width, height: 767 });
      await expect
        .poll(() =>
          page.locator('.graph-view').evaluate((canvas) => {
            const bounds = canvas.getBoundingClientRect();
            return [...canvas.querySelectorAll('.react-flow__node')].every((node) => {
              const rect = node.getBoundingClientRect();
              return (
                rect.left >= bounds.left - 1 &&
                rect.top >= bounds.top - 1 &&
                rect.right <= bounds.right + 1 &&
                rect.bottom <= bounds.bottom + 1
              );
            });
          }),
        )
        .toBe(true);
      const binding = page.locator('.binding-editor').first();
      await binding.scrollIntoViewIfNeeded();
      const geometry = await binding.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const picker = element.querySelector('select')!.getBoundingClientRect();
        const field = element.querySelector('.field')!.getBoundingClientRect();
        const status = element.querySelector('.binding-status')!.getBoundingClientRect();
        const advanced = element.querySelector('.field-details')!.getBoundingClientRect();
        return {
          fullWidth: Math.abs(picker.width - bounds.width) < 1,
          stacked: status.top >= field.bottom && advanced.top >= status.bottom,
          fits: picker.right <= bounds.right + 1 && advanced.right <= bounds.right + 1,
        };
      });
      expect(geometry).toEqual({ fullWidth: true, stacked: true, fits: true });
      await page.screenshot({
        path: test.info().outputPath(`knotra-source-${theme}-${width}.png`),
      });
    }
  });
