import { describe, expect, it } from 'vitest';
import { base64, textBytes } from '../src/lib/bytes';
import { timelineNodeLabel, timelineRows } from '../src/lib/engine/timeline';
import type { EngineEvent, EngineInstance, EngineRun } from '../src/lib/engine/types';
import type { Graph, NodeDefinition } from '../src/lib/types';

const review = (description: string): NodeDefinition => ({
  type: 'human',
  description,
  human: { prompt: { text: 'Review the result.' } },
  outputs: { approved: { schema: { type: 'boolean' } } },
});
const outputs = {
  approved: { schema: { type: 'boolean' }, bind: { from: 'nodes.review.outputs.approved' } },
};
const child: Graph = { nodes: { review: review('Imported review') }, outputs };
const root: Graph = {
  nodes: {
    review: review('Root review'),
    batches: {
      type: 'foreach',
      foreach: {
        over: 'items',
        concurrency: 2,
        with: {},
        body: { nodes: { review: review('Batch review') }, outputs },
      },
    },
    nested: {
      type: 'pipeline',
      pipeline: {
        file: 'child.yaml',
        permissions: { models: [], mcp: {}, sandboxes: [], secrets: [] },
      },
    },
  },
  outputs,
};
const source = (graph: Graph) =>
  JSON.stringify({
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: { name: 'test' },
    spec: graph,
  });
function run(instances: EngineInstance[] = []): EngineRun {
  return {
    id: 'run',
    definitionId: 'definition',
    title: 'Test pipeline',
    status: 'running',
    createdAt: '2026-10-21T12:00:00Z',
    updatedAt: '2026-10-21T12:00:10Z',
    profile: 'local',
    package: {
      entrypoint: 'pipeline.yaml',
      source: source(root),
      files: [{ path: 'child.yaml', content: base64(textBytes(source(child))) }],
    },
    instances,
    inputs: {},
    inputArtifacts: {},
    outputs: {},
    artifacts: [],
    diagnostics: [],
    availableActions: [],
  };
}
function instance(id: string, nodeId: string, extra: Partial<EngineInstance> = {}): EngineInstance {
  return { id, nodeId, status: 'running', scope: 'pipeline.yaml', ...extra };
}
function event(id: string, extra: Partial<EngineEvent> = {}): EngineEvent {
  return {
    id,
    runId: 'run',
    at: '2026-10-21T12:00:01Z',
    type: 'node',
    message: 'running',
    instanceId: 'root-review',
    ...extra,
  };
}

describe('readable run timeline', () => {
  it('uses immutable descriptions and context for equal node IDs across scopes and iterations', () => {
    const value = run([
      instance('root-review', 'review', { graphPath: '/nodes/review' }),
      instance('batch-parent', 'batches', { graphPath: '/nodes/batches' }),
      instance('batch-review', 'review', {
        graphPath: '/nodes/batches/body/nodes/review',
        parentInstanceId: 'batch-parent',
        iterationIndex: 2,
      }),
      instance('import-parent', 'nested', { graphPath: '/nodes/nested' }),
      instance('import-review', 'review', {
        scope: 'child.yaml',
        graphPath: '/nodes/review',
        parentInstanceId: 'import-parent',
      }),
    ]);
    const rows = timelineRows(value, [
      event('3', { instanceId: 'import-review' }),
      event('1'),
      event('2', { instanceId: 'batch-review' }),
    ]);
    expect(rows.map((row) => row.node?.description)).toEqual([
      'Root review',
      'Batch review',
      'Imported review',
    ]);
    expect(rows[1].context).toEqual([{ nodeId: 'batches', iterationIndex: 2 }]);
    expect(rows[2].context).toEqual([{ nodeId: 'nested', iterationIndex: undefined }]);
    expect(value.instances).toHaveLength(5);
  });

  it('resolves a newly projected instance before the next snapshot and retains parent metadata', () => {
    const rows = timelineRows(run(), [
      event('3', { type: 'model.started', instanceId: 'new-review', operationId: 'call' }),
      event('2', {
        instanceId: 'new-review',
        data: {
          nodeId: 'review',
          scope: 'pipeline.yaml',
          graphPath: '/nodes/batches/body/nodes/review',
          nodeType: 'human',
          parentInstanceId: 'new-parent',
          iterationIndex: 0,
          status: 'running',
        },
      }),
      event('1', {
        instanceId: 'new-parent',
        data: { nodeId: 'batches', scope: 'pipeline.yaml', graphPath: '/nodes/batches' },
      }),
    ]);
    expect(rows[2].instance).toMatchObject({
      id: 'new-review',
      nodeId: 'review',
      nodeType: 'human',
    });
    expect(rows[2].node?.description).toBe('Batch review');
    expect(rows[2].context).toEqual([{ nodeId: 'batches', iterationIndex: 0 }]);
  });

  it('does not use a root definition for legacy nested identity without a graph path', () => {
    const rows = timelineRows(
      run([
        instance('parent', 'batches'),
        instance('root-review', 'review', { parentInstanceId: 'parent', iterationIndex: 1 }),
      ]),
      [event('1')],
    );
    expect(rows[0].node).toBeUndefined();
    expect(rows[0].instance?.nodeId).toBe('review');
    expect(rows[0].context).toEqual([{ nodeId: 'batches', iterationIndex: 1 }]);
  });

  it('keeps same call IDs on separate instances distinct, including delta-only streams', () => {
    const rows = timelineRows(
      run([
        instance('first', 'review', { graphPath: '/nodes/review' }),
        instance('second', 'review', { graphPath: '/nodes/review' }),
      ]),
      [
        event('1', {
          type: 'model.delta',
          instanceId: 'first',
          operationId: 'same',
          data: { text: 'First response' },
        }),
        event('2', {
          type: 'model.delta',
          instanceId: 'second',
          operationId: 'same',
          data: { text: 'Second response' },
        }),
      ],
    );
    expect(rows.map((row) => [row.instance?.id, row.activity.text])).toEqual([
      ['first', 'First response'],
      ['second', 'Second response'],
    ]);
    expect(rows[0].activity.events).toEqual([]);
    expect(rows[0].node?.description).toBe('Root review');
  });

  it('uses each recorded attempt instead of assigning the current attempt to old events', () => {
    const rows = timelineRows(
      run([instance('root-review', 'review', { attemptId: 'root-review.a9' })]),
      [
        event('1', { attemptId: 'root-review.a1' }),
        event('2', { attemptId: 'root-review.a2' }),
        event('3'),
      ],
    );
    expect(rows.map((row) => row.attempt)).toEqual([1, 2, undefined]);
  });

  it('numbers opaque attempt IDs independently for each instance', () => {
    const rows = timelineRows(run(), [
      event('1', { instanceId: 'one', attemptId: 'old-attempt' }),
      event('2', { instanceId: 'one', attemptId: 'old-attempt' }),
      event('3', { instanceId: 'one', attemptId: 'retry-attempt' }),
      event('4', { instanceId: 'two', attemptId: 'retry-attempt' }),
    ]);
    expect(rows.map((row) => row.attempt)).toEqual([1, 1, 2, 1]);
  });

  it('deduplicates and sorts custom events without losing them to a foreign run with the same ID', () => {
    const custom = event('2', { type: 'audit.note', message: 'A useful custom event.' });
    const rows = timelineRows(run(), [
      custom,
      event('1', { type: 'run', instanceId: undefined, message: 'pending' }),
      custom,
      event('2', { runId: 'other-run', message: 'Foreign event' }),
    ]);
    expect(rows.map((row) => row.activity.events[0].message)).toEqual([
      'pending',
      'A useful custom event.',
    ]);
    expect(rows[1].instance).toBeUndefined();
  });

  it('guards cyclic ancestry and uses graph-path context when a parent snapshot is missing', () => {
    const rows = timelineRows(
      run([
        instance('one', 'review', { parentInstanceId: 'two' }),
        instance('two', 'batches', { parentInstanceId: 'one', iterationIndex: 3 }),
        instance('orphan', 'review', {
          parentInstanceId: 'missing',
          graphPath: '/nodes/batches/body/nodes/review',
          iterationIndex: 0,
        }),
      ]),
      [event('1', { instanceId: 'one' }), event('2', { instanceId: 'orphan' })],
    );
    expect(rows[0].context).toEqual([{ nodeId: 'batches', iterationIndex: undefined }]);
    expect(rows[1].context).toEqual([{ nodeId: 'batches', iterationIndex: 0 }]);
    expect(rows[1].node?.description).toBe('Batch review');
  });
});

it('humanizes node IDs without expanding runtime IDs or lowercasing acronyms', () => {
  expect(timelineNodeLabel('draft_answer')).toBe('Draft answer');
  expect(timelineNodeLabel('review-result')).toBe('Review result');
  expect(timelineNodeLabel('generateHTTPResponse')).toBe('Generate HTTP response');
  expect(timelineNodeLabel('')).toBe('');
});
