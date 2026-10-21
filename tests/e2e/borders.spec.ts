import { expect, test } from '@playwright/test';
import { addStarterPipeline } from './authoring';

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} separators leave the other edges borderless`, async ({ page }) => {
    async function expectBorders(selector: string, expected: number[]) {
      const elements = page.locator(selector);
      await expect(elements).not.toHaveCount(0);

      const widths = await elements.evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ].map(Number.parseFloat);
        }),
      );
      for (const sides of widths) expect(sides, selector).toEqual(expected);
    }

    await page.goto('/');
    await addStarterPipeline(page, 'Hello, model');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
      .click();
    await expectBorders('.setting-row', [1, 0, 0, 0]);
    await expectBorders('.settings-card', [1, 1, 1, 1]);
    await expectBorders('.app-sidebar', [0, 1, 0, 0]);
    await expectBorders('.app-header', [0, 0, 1, 0]);
    await expectBorders('.sidebar-environment', [1, 0, 0, 0]);

    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await navigation.getByRole('button', { name: 'Pipelines', exact: true }).click();
    await expectBorders('.pipeline-card-footer', [1, 0, 0, 0]);
    await expectBorders('.pipeline-card', [1, 1, 1, 1]);
    await navigation.getByRole('button', { name: 'Runs', exact: true }).click();
    await expectBorders('.engine-banner', [0, 0, 1, 0]);
  });
}
