import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { parse } from 'yaml';
import { pipelineAction } from './authoring';

test.use({ storageState: { cookies: [], origins: [] } });
const ru = JSON.parse(readFileSync('src/locales/ru.json', 'utf8'));
const tourKey = 'knotra.tour.v1';
const workspaceKey = 'knotra.workspace.v1';
const tour = (page: Page) => page.getByRole('region', { name: 'Knotra tour', exact: true });
const next = (page: Page) => tour(page).getByRole('button', { name: 'Next', exact: true }).click();

async function savedWorkspace(page: Page) {
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), workspaceKey))
    .not.toBeNull();
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), workspaceKey);
}

async function buildLearningPipeline(page: Page) {
  await tour(page).getByRole('button', { name: 'Create learning pipeline', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My first pipeline', exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  const instructions = page.getByRole('textbox', { name: 'Instructions', exact: true });
  await instructions.fill(
    'Answer the supplied question in two clear sentences. Return the answer as text.',
  );
  await instructions.press('Tab');
  await next(page);
  await expect(tour(page)).toContainText('3 of 8');
  await tour(page).getByRole('button', { name: 'Choose review block', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Human review/ })
    .click();
  await expect(tour(page)).toContainText('4 of 8');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(tour(page).getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'answer output text', exact: true }).click();
  await page.getByRole('button', { name: 'human input draft', exact: true }).click();
  await expect(tour(page).getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => {
      const state = await savedWorkspace(page);
      return parse(state.workspaces[0].source).spec.nodes.human?.inputs?.draft?.bind?.from;
    })
    .toBe('nodes.answer.outputs.text');
}

test('fresh launch is empty and the lesson teaches editing, adding and connecting one real pipeline', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.pipeline-card')).toHaveCount(0);
  await expect(page.locator('.sidebar-pipelines > button')).toHaveCount(0);
  await expect(tour(page)).toContainText('1 of 8');
  expect((await savedWorkspace(page)).workspaces).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('tour-empty-start.png') });
  await buildLearningPipeline(page);
  await page.screenshot({ path: testInfo.outputPath('tour-connected-lesson.png') });
  await next(page);
  await expect(tour(page)).toContainText('5 of 8');
  await expect(page.locator('.model-setup')).toBeInViewport();
  await expect(page.locator('.workspace-tour-target')).toBeVisible();
  await expect(tour(page)).toHaveCSS('position', 'fixed');
  await tour(page).getByRole('button', { name: 'Skip model setup', exact: true }).click();
  await expect(tour(page)).toContainText('6 of 8');
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toHaveValue('');
  await expect(model).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Model ID', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-tour="node-model"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('tour-model-binding.png') });
  await next(page);
  await expect(tour(page)).toContainText('7 of 8');
  await expect(page.locator('[data-tour="run"]')).toHaveText('Connect engine');
  await tour(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(model).toHaveValue('');
  await next(page);
  await next(page);
  await expect(
    page.getByRole('heading', { name: 'Needs your response', exact: true }),
  ).toBeVisible();
  await tour(page).getByRole('button', { name: 'Finish tour', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
  await page.reload();
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('.pipeline-card')).toHaveCount(1);
  const state = await savedWorkspace(page);
  expect(state.runs).toEqual([]);
  expect(state.workspaces).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('skip creates nothing; replay reuses the lesson and preserves its edits', async ({ page }) => {
  await page.goto('/');
  await tour(page).getByRole('button', { name: 'Skip tour', exact: true }).click();
  await page.reload();
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator('.pipeline-card')).toHaveCount(0);
  await page
    .locator('.sidebar-bottom')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Restart tour', exact: true }).click();
  await buildLearningPipeline(page);
  const before = await savedWorkspace(page);
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await page.reload();
  await page
    .locator('.sidebar-bottom')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Restart tour', exact: true }).click();
  await tour(page).getByRole('button', { name: 'Continue learning pipeline', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue(
    'Answer the supplied question in two clear sentences. Return the answer as text.',
  );
  expect((await savedWorkspace(page)).workspaces).toEqual(before.workspaces);
  await expect(page.locator('.sidebar-pipelines > button')).toHaveCount(1);
});

test('lesson dialogs pause the tour and Back restores the model prompt', async ({ page }) => {
  await page.goto('/');
  await buildLearningPipeline(page);
  await tour(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(tour(page)).toContainText('3 of 8');
  await tour(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(tour(page)).toContainText('2 of 8');
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible();
  await page.locator('[data-tour="nav-inbox"]').click();
  await expect(tour(page)).toContainText('8 of 8');
  await page.locator('[data-tour="nav-pipelines"]').click();
  await expect(tour(page)).toContainText('1 of 8');
});

test('deleting the learning pipeline lets replay create exactly one replacement', async ({
  page,
}) => {
  await page.goto('/');
  await tour(page).getByRole('button', { name: 'Create learning pipeline', exact: true }).click();
  await page.keyboard.press('Escape');
  await pipelineAction(page, 'Delete pipeline');
  await page.getByRole('button', { name: 'Remove pipeline', exact: true }).click();
  await expect(page.locator('.pipeline-card')).toHaveCount(0);
  await page
    .locator('.sidebar-bottom')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Restart tour', exact: true }).click();
  await tour(page).getByRole('button', { name: 'Create learning pipeline', exact: true }).click();
  await expect(page.locator('.sidebar-pipelines > button')).toHaveCount(1);
  expect((await savedWorkspace(page)).workspaces).toHaveLength(1);
});

test('replay preserves a lesson changed beyond its starting blocks and offers a fresh one', async ({
  page,
}) => {
  await page.goto('/');
  await buildLearningPipeline(page);
  await page.keyboard.press('Escape');
  await page.getByTestId('rf__node-answer').click();
  await page.getByRole('button', { name: 'Delete node', exact: true }).click();
  await page.getByRole('button', { name: 'Remove node', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => parse((await savedWorkspace(page)).workspaces[0].source).spec.nodes.answer)
    .toBeUndefined();
  const edited = (await savedWorkspace(page)).workspaces[0];
  await page
    .locator('.sidebar-bottom')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Restart tour', exact: true }).click();
  await expect(tour(page)).toContainText('Your existing pipeline and its edits stay unchanged.');
  await tour(page).getByRole('button', { name: 'Create learning pipeline', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(page.locator('.sidebar-pipelines > button')).toHaveCount(2);
  const after = await savedWorkspace(page);
  expect(after.workspaces.find((workspace: { id: string }) => workspace.id === edited.id)).toEqual(
    edited,
  );
});

test.describe('Russian lesson on a smaller desktop window', () => {
  test.use({ locale: 'ru-RU', viewport: { width: 1000, height: 700 } });
  test('starts empty and leaves the prompt visible beside the light-theme guide', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    const guide = page.getByRole('region', { name: ru['tour.label'], exact: true });
    await guide.getByRole('button', { name: ru['tour.skip'], exact: true }).click();
    await page
      .locator('.sidebar-bottom')
      .getByRole('button', { name: ru['navigation.settings'], exact: true })
      .click();
    await page.getByRole('radio', { name: ru['resources.light'], exact: true }).click();
    await page.getByRole('button', { name: ru['tour.settings.start'], exact: true }).click();
    await guide.getByRole('button', { name: ru['tour.createLesson'], exact: true }).click();
    const prompt = page.getByRole('textbox', { name: ru['editor.instructions'], exact: true });
    await expect(prompt).toHaveValue(ru['tour.pipeline.prompt']);
    const cardBox = (await guide.boundingBox())!;
    const promptBox = (await prompt.boundingBox())!;
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.y).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(promptBox.x);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(700);
    await page.screenshot({ path: testInfo.outputPath('tour-russian-prompt-small.png') });
  });
});

test('reduced motion keeps the lesson guide still and usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await tour(page).getByRole('button', { name: 'Create learning pipeline', exact: true }).click();
  await expect(tour(page)).toContainText('2 of 8');
  expect(await tour(page).evaluate((panel) => panel.getAnimations({ subtree: true }).length)).toBe(
    0,
  );
  expect(
    await page
      .locator('.workspace-tour-target')
      .evaluate((target) => target.getAnimations().length),
  ).toBe(0);
  await tour(page).getByRole('button', { name: 'Skip tour', exact: true }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), tourKey)).toBe('dismissed');
});

test('learning pipeline runs on a real engine and delivers its answer to human review', async ({
  page,
}, testInfo) => {
  const endpoint = process.env.KNOTRA_E2E_ENDPOINT;
  test.skip(!endpoint, 'Set KNOTRA_E2E_ENDPOINT for the real model learning pipeline check.');
  test.setTimeout(180_000);
  await page.goto('/');
  await buildLearningPipeline(page);
  await next(page);
  await page
    .locator('.sidebar-bottom')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Engine base URL', exact: true }).fill(endpoint!);
  await page.getByRole('button', { name: 'Connect engine', exact: true }).click();
  await expect(page.getByText(/ · knotra.desktop\/1$/)).toBeVisible();
  await tour(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Source', exact: true })).toHaveValue(
    'model_main',
  );
  await next(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Start run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My first pipeline', exact: true })).toBeVisible();
  await page.locator('[data-tour="nav-inbox"]').click();
  const requestRow = page
    .locator('.request-list > button')
    .filter({ hasText: 'My first pipeline' });
  await expect(requestRow).toBeVisible({ timeout: 120_000 });
  await requestRow.click();
  await expect(page.locator('.review-card')).toContainText('draft');
  await expect(
    page.getByRole('region', { name: 'From previous steps', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Engine review response', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'Your answer', exact: true })
    .fill('Reviewed during the learning tour.');
  await page.getByRole('button', { name: 'Submit response', exact: true }).click();
  await expect(requestRow).toHaveCount(0);
  const response = await page.request.get(`${endpoint}/v1/runs`);
  const run = (await response.json()).items.find(
    (item: { title: string }) => item.title === 'My first pipeline',
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`${endpoint}/v1/runs/${run.id}`)).json()).run.status,
    )
    .toBe('succeeded');
  const completed = (await (await page.request.get(`${endpoint}/v1/runs/${run.id}`)).json()).run;
  expect(completed.outputs.answer).toEqual(expect.any(String));
  expect(completed.outputs.answer.length).toBeGreaterThan(0);
  expect(
    completed.instances.every((instance: { status: string }) => instance.status === 'succeeded'),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('real-learning-review-complete.png') });
  await tour(page).getByRole('button', { name: 'Finish tour', exact: true }).click();
});
