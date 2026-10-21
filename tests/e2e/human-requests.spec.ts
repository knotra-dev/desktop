import { expect, test } from '@playwright/test';

test('human review shows the task and draft and submits ordinary fields without JSON', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/frontend-audit.html?component=inbox&fields=1');
  await expect(page.getByRole('region', { name: 'From previous steps' })).toContainText(
    'A short draft for your review.',
  );
  await expect(
    page.getByText('Read the draft and write your response.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Engine review response' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Submit response', exact: true }).click();
  expect(
    await page.evaluate(() => (window as unknown as { auditCommands: unknown[] }).auditCommands),
  ).toEqual([]);
  await page
    .getByRole('textbox', { name: 'Your answer', exact: true })
    .fill('Please make the first sentence clearer.');
  await page.getByRole('combobox', { name: 'Approval', exact: true }).selectOption({ label: 'No' });
  await page.getByRole('button', { name: 'Submit response', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { auditCommands: { outputs: unknown }[] }).auditCommands.at(-1)
            ?.outputs,
      ),
    )
    .toEqual({ answer: 'Please make the first sentence clearer.', approved: false });
});

test('plain response fields preserve each request draft through navigation', async ({ page }) => {
  await page.goto('/tests/fixtures/frontend-audit.html?component=inbox&fields=1');
  const answer = page.getByRole('textbox', { name: 'Your answer', exact: true });
  const approval = page.getByRole('combobox', { name: 'Approval', exact: true });
  await answer.fill('First draft');
  await approval.selectOption({ label: 'Yes' });
  await page.getByRole('button', { name: /review_second/ }).click();
  await expect(answer).toHaveValue('');
  await expect(approval).toHaveValue('');
  await answer.fill('Second draft');
  await page.getByRole('button', { name: /review_first/ }).click();
  await expect(answer).toHaveValue('First draft');
  await expect(approval).toHaveValue('0');
  await page.getByRole('button', { name: 'View run', exact: true }).click();
  await page.getByRole('button', { name: 'Return to inbox', exact: true }).click();
  await expect(answer).toHaveValue('First draft');
  await page.getByRole('button', { name: /review_second/ }).click();
  await expect(answer).toHaveValue('Second draft');
});

test('Advanced JSON preserves malformed drafts without replacing them with empty form fields', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/frontend-audit.html?component=inbox&fields=1');
  await page.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Advanced JSON', exact: true }).click();
  const json = page.getByRole('textbox', { name: 'Engine review response', exact: true });
  expect(JSON.parse(await json.inputValue()).answer).toBe('Keep this draft');
  await json.fill('{unfinished');
  await page.getByRole('button', { name: /review_second/ }).click();
  await page.getByRole('button', { name: /review_first/ }).click();
  await expect(json).toHaveValue('{unfinished');
  await expect(page.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveCount(0);
});

test('custom field names stay labeled and Unicode length limits follow the response schema', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/frontend-audit.html?component=inbox&fields=unicode');
  const custom = page.getByRole('textbox', { name: 'constructor', exact: true });
  const answer = page.getByRole('textbox', { name: 'Your answer', exact: true });
  await custom.pressSequentially('🙂');
  await answer.pressSequentially('🙂');
  await page.getByRole('button', { name: 'Submit response', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Complete the required fields');
  expect(
    await page.evaluate(() => (window as unknown as { auditCommands: unknown[] }).auditCommands),
  ).toEqual([]);
  await answer.pressSequentially('🙂');
  await expect(custom).toHaveValue('🙂');
  await expect(answer).toHaveValue('🙂🙂');
  await page.getByRole('button', { name: 'Submit response', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { auditCommands: { outputs: unknown }[] }).auditCommands.at(-1)
            ?.outputs,
      ),
    )
    .toEqual({ constructor: '🙂', answer: '🙂🙂' });
});

for (const theme of ['dark', 'light']) {
  test(`Russian human review stays readable in the minimum content area (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 802, height: 620 });
    await page.goto(
      `/tests/fixtures/frontend-audit.html?component=inbox&fields=1&locale=ru&theme=${theme}`,
    );
    await expect(
      page.getByText('Прочитайте черновик и напишите ответ.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Короткий черновик для проверки.', { exact: true })).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Ваш ответ', exact: true })
      .fill('Добавьте пример в первый абзац.');
    await page
      .getByRole('combobox', { name: 'Одобрение', exact: true })
      .selectOption({ label: 'Нет' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`human-review-${theme}.png`),
      fullPage: true,
    });
  });
}
