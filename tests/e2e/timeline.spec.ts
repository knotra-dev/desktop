import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { expect, type Page, test } from '@playwright/test';
import type { EngineEvent, EngineRun } from '../../src/lib/engine/types';

test.use({ locale: 'en-US' });
let server: Server;
let endpoint = '';
let streams: ServerResponse[] = [];
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, seconds)).toISOString();
const writerId = 'ins_01k82y8q1hwriter8a4c27b3e6e397eef';
const reviewerId = 'ins_01k82y8q1hrevuwer06a4c27b3e6e397eef';
const writerAttempt = `${writerId}.a1`;
const reviewerAttempt = `${reviewerId}.a2`;
const operationId = 'op_01k82y8q1h55af87c06614ddd8c6e06f';
const failure = 'Review could not finish because the document service timed out. Retry this step.';
const source = `apiVersion: knotra/v1
kind: Pipeline
metadata: {name: timeline-fixture}
spec:
  models: {writer: {connection: local_model}}
  nodes:
    writer:
      type: llm
      llm: {model: writer, prompt: {text: 'Write an answer.'}}
      outputs: {answer: {schema: {type: string}}}
    reviewer:
      type: llm
      llm: {model: writer, prompt: {text: 'Review the answer.'}}
      outputs: {answer: {schema: {type: string}}}
  outputs: {}
`;
const run: EngineRun = {
  id: 'run_01k82y8q1hfb4502a4a27ef9911d912a',
  definitionId: 'def_01k82y8q1hfb4502a4a27ef9911d912a',
  title: 'Document review',
  profile: 'local',
  status: 'failed',
  createdAt: at(0),
  updatedAt: at(20),
  package: {
    entrypoint: 'pipeline.yaml',
    source,
    files: [{ path: 'pipeline.yaml', content: Buffer.from(source).toString('base64') }],
  },
  inputs: {},
  inputArtifacts: {},
  outputs: {},
  artifacts: [],
  diagnostics: [],
  availableActions: [],
  instances: [
    {
      id: writerId,
      nodeId: 'writer',
      scope: 'pipeline.yaml',
      nodeType: 'llm',
      graphPath: '/nodes/writer',
      status: 'succeeded',
      attemptId: writerAttempt,
      startedAt: at(2),
      finishedAt: at(8),
    },
    {
      id: reviewerId,
      nodeId: 'reviewer',
      scope: 'pipeline.yaml',
      nodeType: 'llm',
      graphPath: '/nodes/reviewer',
      status: 'failed',
      attemptId: reviewerAttempt,
      iterationIndex: 1,
      startedAt: at(10),
      finishedAt: at(19),
    },
  ],
};
const history: EngineEvent[] = [
  {
    id: 'evt_pipeline_started_01k82y8q1h',
    runId: run.id,
    at: at(1),
    type: 'run',
    message: 'running',
    data: { status: 'running' },
  },
  {
    id: 'evt_writer_started_01k82y8q1h',
    runId: run.id,
    at: at(2),
    type: 'node',
    message: 'running',
    instanceId: writerId,
    attemptId: writerAttempt,
    data: { status: 'running', nodeId: 'writer', nodeType: 'llm' },
  },
  ...Array.from({ length: 5 }, (_, index) => ({
    id: `evt_writer_delta_01k82y8q1h_${index}`,
    runId: run.id,
    at: at(3 + index),
    type: 'model.delta',
    message: 'model.delta',
    instanceId: writerId,
    attemptId: writerAttempt,
    operationId,
    data: { text: 'Writing a useful answer. ' },
  })),
  {
    id: 'evt_writer_finished_01k82y8q1h',
    runId: run.id,
    at: at(8),
    type: 'node',
    message: 'succeeded',
    instanceId: writerId,
    attemptId: writerAttempt,
    data: { status: 'succeeded', nodeId: 'writer', nodeType: 'llm' },
  },
  {
    id: 'evt_reviewer_retry_01k82y8q1h',
    runId: run.id,
    at: at(9),
    type: 'node',
    message: 'retry_wait',
    instanceId: reviewerId,
    attemptId: reviewerAttempt,
    data: { status: 'retry_wait', nodeId: 'reviewer', iterationIndex: 1 },
  },
  {
    id: 'evt_reviewer_started_01k82y8q1h',
    runId: run.id,
    at: at(10),
    type: 'node',
    message: 'running',
    instanceId: reviewerId,
    attemptId: reviewerAttempt,
    data: { status: 'running', nodeId: 'reviewer', iterationIndex: 1 },
  },
  {
    id: 'evt_reviewer_failure_01k82y8q1h',
    runId: run.id,
    at: at(19),
    type: 'node',
    message: failure,
    instanceId: reviewerId,
    attemptId: reviewerAttempt,
    operationId,
    data: { status: 'failed', nodeId: 'reviewer', iterationIndex: 1 },
  },
  {
    id: 'evt_pipeline_failed_01k82y8q1h',
    runId: run.id,
    at: at(20),
    type: 'run',
    message: 'failed',
    data: { status: 'failed' },
  },
];

let fixtureRun = run;
let fixtureHistory = history;

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(JSON.stringify(value));
}

test.beforeEach(async () => {
  streams = [];
  fixtureRun = run;
  fixtureHistory = history;
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
    if (request.method !== 'GET')
      return json(
        response,
        { code: 'READ_ONLY_FIXTURE', message: 'No mutations expected', diagnostics: [] },
        405,
      );

    const url = new URL(request.url!, endpoint);
    if (url.pathname === '/v1/info')
      return json(response, {
        protocol: 'knotra.desktop/1',
        engineId: 'timeline-engine',
        principalId: 'timeline-user',
        version: 'fixture',
        capabilities: ['runs', 'events', 'history'],
      });
    if (url.pathname === '/v1/profiles')
      return json(response, { items: [{ id: 'local', title: 'Local', revision: 'fixture' }] });
    if (
      ['/v1/resources', '/v1/requests', '/v1/artifacts', '/v1/definitions'].includes(url.pathname)
    )
      return json(response, { items: [], nextCursor: null });
    if (url.pathname === '/v1/runs')
      return json(response, { items: [fixtureRun], nextCursor: null });
    if (url.pathname === `/v1/runs/${run.id}`) return json(response, { run: fixtureRun });
    if (url.pathname === `/v1/runs/${run.id}/history`)
      return json(response, { items: fixtureHistory, nextCursor: null });
    if (url.pathname === `/v1/runs/${run.id}/events`) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      for (const event of fixtureHistory)
        response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      streams.push(response);
      return;
    }

    return json(response, { code: 'NOT_FOUND', message: url.pathname, diagnostics: [] }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.afterEach(async () => {
  for (const stream of streams) stream.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function openTimeline(page: Page, locale: 'en' | 'ru', theme: 'dark' | 'light') {
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
  await expect(page.getByText('timeline-engine', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: t['navigation.main'] })
    .getByRole('button', { name: t['navigation.runs'], exact: true })
    .click();
  await page.locator('.run-table-row').filter({ hasText: 'Document review' }).click();
  await page
    .locator('.underline-tabs')
    .getByRole('button', { name: t['execution.timeline'], exact: true })
    .click();

  return t;
}

for (const locale of ['en', 'ru'] as const)
  for (const theme of ['dark', 'light'] as const)
    test(`${locale} ${theme} timeline explains each step and fits the minimum window`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1000, height: 680 });
      const t = await openTimeline(page, locale, theme);
      const timeline = page.locator('.run-timeline');
      const rows = timeline.locator('ol > .timeline-event');
      await expect(rows).toHaveCount(8);
      await expect(timeline).toContainText('Writer');
      await expect(timeline).toContainText('Reviewer');
      await expect(timeline).toContainText(t['timeline.started']);
      await expect(timeline).toContainText(t['timeline.completed']);
      await expect(timeline).toContainText(t['timeline.retry']);
      await expect(timeline).toContainText(t['timeline.attempt'].replace('{count}', '2'));
      await expect(timeline).toContainText(t['observe.iteration'].replace('{count}', '2'));

      const streaming = rows.filter({ hasText: t['observe.modelCall'] });
      await expect(streaming).toHaveCount(1);
      await expect(streaming).toContainText(t['timeline.incomplete']);
      await expect(timeline.getByText(failure, { exact: true })).toBeVisible();
      await expect(timeline.locator('time')).toHaveCount(8);
      for (const id of [
        writerId,
        reviewerId,
        writerAttempt,
        reviewerAttempt,
        operationId,
        ...history.map((event) => event.id),
      ])
        await expect(timeline).not.toContainText(id);
      const details = timeline.getByRole('button', {
        name: t['timeline.technicalDetails'],
        exact: true,
      });

      await expect(details).toHaveCount(8);
      for (const detail of await details.all())
        await expect(detail).toHaveAttribute('aria-expanded', 'false');
      await expect
        .poll(() =>
          timeline.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              document.documentElement.scrollWidth <= innerWidth &&
              element.scrollWidth <= element.clientWidth + 1 &&
              [...element.querySelectorAll('button,time')].every((control) => {
                const rect = control.getBoundingClientRect();
                return rect.left >= bounds.left && rect.right <= bounds.right + 1;
              })
            );
          }),
        )
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`timeline-${locale}-${theme}-1000.png`),
        fullPage: true,
      });
      const failedRow = rows.filter({ hasText: failure });
      await failedRow
        .getByRole('button', { name: t['timeline.technicalDetails'], exact: true })
        .click();
      await expect(failedRow.locator('pre')).toContainText(reviewerId);
      await expect(failedRow.locator('pre')).toContainText(reviewerAttempt);
      await expect(failedRow.locator('pre')).toContainText(operationId);
      await expect(failedRow.locator('pre')).toContainText('evt_reviewer_failure_01k82y8q1h');
      expect(errors).toEqual([]);
    });

test('long step names and completed model time ranges remain readable', async ({
  page,
}, testInfo) => {
  const longName =
    'prepare_researchBrief_for_multilingual_customerExperience_qualityAssuranceReview';
  fixtureRun = structuredClone(run);
  fixtureRun.instances[0].nodeId = longName;
  fixtureRun.instances[0].graphPath = `/nodes/${longName}`;
  fixtureRun.package.source = source.replace('    writer:', `    ${longName}:`);
  fixtureRun.package.files[0].content = Buffer.from(fixtureRun.package.source).toString('base64');
  const operation = { runId: run.id, instanceId: writerId, attemptId: writerAttempt, operationId };
  fixtureHistory = [
    ...history.slice(0, 2),
    {
      ...operation,
      id: 'evt_model_started_01k82y8q1h',
      at: at(2),
      type: 'model.started',
      message: 'model.started',
      data: { step: 1, model: 'gpt-fixture' },
    },
    ...history.slice(2, 7),
    {
      ...operation,
      id: 'evt_model_completed_01k82y8q1h',
      at: at(8),
      type: 'model.completed',
      message: 'model.completed',
      data: { step: 1, model: 'gpt-fixture', text: 'Completed answer.' },
    },
    ...history.slice(7),
  ];
  await page.setViewportSize({ width: 1000, height: 680 });
  const t = await openTimeline(page, 'en', 'dark');
  const timeline = page.locator('.run-timeline');
  await expect(timeline.locator('ol > .timeline-event')).toHaveCount(8);

  const model = timeline
    .locator('.timeline-event')
    .filter({ hasText: t['timeline.modelCompleted'] });
  await expect(model).toHaveCount(1);
  await expect(model.locator('h3')).toHaveText(
    'Prepare research brief for multilingual customer experience quality assurance review',
  );
  await expect(model.locator('time')).toHaveCount(2);
  await expect(model.locator('time').first()).toHaveAttribute('datetime', at(2));
  await expect(model.locator('time').last()).toHaveAttribute('datetime', at(8));
  await expect(model.locator('time').first().locator('..')).toContainText(' – ');
  expect(
    await timeline.evaluate(
      (element) =>
        document.documentElement.scrollWidth <= innerWidth &&
        element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await model.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('timeline-long-step-completed-model-1000.png'),
    fullPage: true,
  });
});
