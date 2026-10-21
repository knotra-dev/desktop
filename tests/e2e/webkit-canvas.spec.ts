import { expect, test } from '@playwright/test';

test('canvas measurements remain stable when switching between code and canvas', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/tests/fixtures/frontend-audit.html?component=workspace');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();

  for (let cycle = 0; cycle < 5; cycle++) {
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await expect(page.locator('.cm-editor')).toBeVisible();
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
  }

  expect(errors).toEqual([]);
});
