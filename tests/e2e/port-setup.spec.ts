import { expect, type Page, test } from '@playwright/test';
import { parse } from 'yaml';
import { activeWorkspace } from './authoring';

const source = `apiVersion: knotra/v1
kind: Pipeline
metadata:
  name: explained-ports
spec:
  nodes:
    source:
      type: human
      human:
        prompt: {text: Supply a draft and its context.}
      outputs:
        text: {schema: {type: string}}
        payload: {schema: {type: object}}
    review:
      type: human
      inputs:
        draft:
          description: The draft this person should review.
          schema: {type: string}
          bind: {from: nodes.source.outputs.text}
        context:
          schema:
            type: object
            properties: {topic: {type: string}}
            required: [topic]
            additionalProperties: false
          bind: {from: nodes.source.outputs.payload, path: /metadata}
        fallback:
          schema: {type: string}
          bind:
            coalesce:
              - {from: nodes.source.outputs.text}
              - {value: No draft supplied}
      human:
        prompt: {text: Review the draft and return feedback.}
      outputs:
        feedback:
          description: Comments returned by the reviewer.
          schema: {type: string}
  outputs:
    feedback: {schema: {type: string}, bind: {from: nodes.review.outputs.feedback}}
`;

async function open(page: Page) {
  await page.goto('/');
  await page.getByLabel('Import pipeline package', { exact: true }).setInputFiles({
    name: 'pipeline.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(source),
  });
  await page.getByTestId('rf__node-review').click();
  await page.getByRole('button', { name: 'Inputs & outputs', exact: true }).click();
  await expect(page.getByText('Local checks passed', { exact: true })).toBeVisible();
}

function port(page: Page, name: string) {
  return page.locator('.port-editor-card').filter({
    has: page.locator('strong').filter({ hasText: new RegExp(`^${name}$`) }),
  });
}

async function review(page: Page) {
  return parse((await activeWorkspace(page)).source).spec.nodes.review;
}

test('basic port setup explains its purpose and connects data without showing schemas', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 680 });
  await open(page);
  const draft = port(page, 'draft');
  await expect(draft).toContainText('The draft this person should review.');
  await expect(draft.locator('.binding-status')).toContainText('source → text');
  await expect(draft.getByRole('combobox', { name: 'Type of draft', exact: true })).toBeHidden();
  await expect(draft.getByRole('textbox', { name: 'Schema for draft', exact: true })).toBeHidden();
  await draft
    .getByRole('combobox', { name: 'Source for draft', exact: true })
    .selectOption('$value');
  const value = draft.getByRole('textbox', { name: 'Value for draft', exact: true });
  await value.fill('Please check this draft.');
  await value.press('Tab');
  await expect
    .poll(async () => (await review(page)).inputs.draft)
    .toEqual({
      description: 'The draft this person should review.',
      schema: { type: 'string' },
      bind: { value: 'Please check this draft.' },
    });
  await draft
    .getByRole('combobox', { name: 'Source for draft', exact: true })
    .selectOption('nodes.source.outputs.text');
  await expect
    .poll(async () => (await review(page)).inputs.draft.bind)
    .toEqual({ from: 'nodes.source.outputs.text' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await draft.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('ports-basic-1000.png') });
});

test('advanced format disclosure preserves data bindings and allows schema changes', async ({
  page,
}) => {
  await open(page);
  const before = await review(page);
  const draft = port(page, 'draft');
  await draft.getByText('Schema & details', { exact: true }).click();
  const schema = draft.getByRole('textbox', { name: 'Schema for draft', exact: true });
  await schema.fill('{"type":"string","minLength":1}');
  await schema.press('Tab');
  await expect
    .poll(async () => (await review(page)).inputs.draft.schema)
    .toEqual({ type: 'string', minLength: 1 });

  const after = await review(page);
  expect(after.inputs.draft.bind).toEqual(before.inputs.draft.bind);
  expect(after.inputs.context).toEqual(before.inputs.context);
  expect(after.inputs.fallback).toEqual(before.inputs.fallback);
  expect(after.outputs).toEqual(before.outputs);
  await draft.getByText('Schema & details', { exact: true }).click();
  await expect(schema).toBeHidden();
  await expect(
    draft.getByRole('combobox', { name: 'Source for draft', exact: true }),
  ).toBeVisible();
});

test('existing fallback and pointer bindings stay editable in advanced mapping', async ({
  page,
}) => {
  await open(page);
  const context = port(page, 'context');
  await context.getByText('Select part of the output', { exact: true }).click();
  await expect(context.getByRole('textbox', { name: 'JSON pointer', exact: true })).toHaveValue(
    '/metadata',
  );

  const fallback = port(page, 'fallback');
  const bindings = fallback.getByRole('textbox', {
    name: 'Fallback bindings for fallback',
    exact: true,
  });

  await expect(bindings).toBeVisible();
  await bindings.fill('[{"from":"nodes.source.outputs.text"},{"value":"No review draft"}]');
  await bindings.press('Tab');
  await expect
    .poll(async () => (await review(page)).inputs.fallback.bind.coalesce)
    .toEqual([{ from: 'nodes.source.outputs.text' }, { value: 'No review draft' }]);
  await fallback
    .getByRole('combobox', { name: 'Source for fallback', exact: true })
    .selectOption('$expression');
  const expression = fallback.getByRole('textbox', {
    name: 'Expression for fallback',
    exact: true,
  });
  await expression.fill('"Computed review"');
  await expression.press('Tab');
  await expect
    .poll(async () => (await review(page)).inputs.fallback.bind)
    .toEqual({ expr: '"Computed review"' });
  expect((await review(page)).inputs.context.bind.path).toBe('/metadata');
});
