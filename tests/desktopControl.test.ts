import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  applyPipelineControl,
  rollbackControlChange,
  workspaceRevision,
} from '../src/lib/desktopControl';
import { freshState, type State } from '../src/lib/storage';
import type { Workspace } from '../src/lib/types';

function source(title = 'External pipeline') {
  return stringify({
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: { name: 'external-pipeline', title },
    spec: {
      nodes: {
        review: {
          type: 'human',
          human: { prompt: { text: 'Review this request.' } },
          outputs: { approved: { schema: { type: 'boolean' } } },
        },
      },
      outputs: {
        approved: {
          schema: { type: 'boolean' },
          bind: { from: 'nodes.review.outputs.approved' },
        },
      },
    },
  });
}

function workspace(id = 'first'): Workspace {
  const yaml = source();
  return {
    id,
    source: yaml,
    savedSource: yaml,
    entrypoint: 'pipeline.yaml',
    files: [{ path: 'notes.txt', content: 'a2VlcCBtZQ==' }],
    positions: { review: { x: 120, y: 240 } },
    updatedAt: '2026-10-21T00:00:00Z',
  };
}

function state(): State {
  return {
    ...freshState(),
    engineMode: 'manual',
    engineUrl: 'https://engine.example.test',
    workspaces: [workspace(), workspace('unrelated')],
    activeId: 'first',
    locale: 'en',
    compact: true,
  };
}

describe('MCP pipeline control', () => {
  it('revisions cover draft source, supporting files and canvas positions', async () => {
    const value = workspace();
    const revision = await workspaceRevision(value);
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(await workspaceRevision(structuredClone(value))).toBe(revision);
    for (const changed of [
      { ...value, source: `${value.source}\n# changed` },
      { ...value, files: [] },
      { ...value, positions: { review: { x: 121, y: 240 } } },
    ])
      expect(await workspaceRevision(changed)).not.toBe(revision);
  });

  it('lists current drafts and reads their exact editable package without changing state', async () => {
    const value = state();
    value.workspaces[0].source += '\n# unsaved';
    const before = structuredClone(value);
    const listed = await applyPipelineControl(value, 'pipeline_list', {});
    expect(listed.state).toBeUndefined();
    expect(listed.result).toEqual({
      items: await Promise.all(
        value.workspaces.map(async (workspace) => ({
          id: workspace.id,
          name: 'external-pipeline',
          title: 'External pipeline',
          revision: await workspaceRevision(workspace),
          dirty: workspace.id === 'first',
        })),
      ),
    });

    const read = await applyPipelineControl(value, 'pipeline_get', { id: 'first' });
    expect(read.result).toEqual({
      workspace: value.workspaces[0],
      revision: await workspaceRevision(value.workspaces[0]),
    });
    expect(value).toEqual(before);
  });

  it('creates a saved pipeline without replacing existing packages or app preferences', async () => {
    const value = state();
    const before = structuredClone(value);
    const changed = await applyPipelineControl(value, 'pipeline_create', {
      source: source('Created through MCP'),
      activate: false,
    });

    expect(changed.state!.workspaces).toHaveLength(3);
    expect(changed.state!.workspaces.slice(0, 2)).toEqual(value.workspaces);

    const added = changed.state!.workspaces[2];
    expect(added.source).toBe(added.savedSource);
    expect(added.entrypoint).toBe('pipeline.yaml');
    expect(changed.workspaceId).toBe(added.id);
    expect(changed.activate).toBe(false);
    expect({ ...changed.state, workspaces: value.workspaces }).toEqual(value);
    expect(value).toEqual(before);
  });

  it('updates only the selected package and preserves omitted files and positions', async () => {
    const value = state();
    const before = structuredClone(value);
    const changed = await applyPipelineControl(value, 'pipeline_update', {
      id: 'first',
      source: source('Updated through MCP'),
      expectedRevision: await workspaceRevision(value.workspaces[0]),
      activate: false,
    });
    const updated = changed.state!.workspaces[0];
    expect(updated.source).toContain('Updated through MCP');
    expect(updated.savedSource).toBe(updated.source);
    expect(updated.files).toEqual(value.workspaces[0].files);
    expect(updated.positions).toEqual(value.workspaces[0].positions);
    expect(changed.state!.workspaces[1]).toEqual(value.workspaces[1]);
    expect({ ...changed.state, workspaces: value.workspaces }).toEqual(value);
    expect(value).toEqual(before);
  });

  it('requires the current revision for updates and deletes, even with allowDirty', async () => {
    const value = state();
    const before = structuredClone(value);
    for (const operation of ['pipeline_update', 'pipeline_delete'])
      for (const expectedRevision of [undefined, 'stale'])
        await expect(
          applyPipelineControl(value, operation, {
            id: 'first',
            source: source('Must not replace the draft'),
            expectedRevision,
            allowDirty: true,
          }),
        ).rejects.toMatchObject({
          code: 'conflict',
          message: expect.stringContaining('Pipeline changed'),
        });
    expect(value).toEqual(before);
  });

  it('requires explicit acknowledgement before replacing an unsaved draft', async () => {
    const value = state();
    value.workspaces[0].source += '\n# local work';
    const before = structuredClone(value);
    const args = {
      id: 'first',
      source: source('Acknowledged replacement'),
      expectedRevision: await workspaceRevision(value.workspaces[0]),
    };
    for (const operation of ['pipeline_update', 'pipeline_delete'])
      await expect(applyPipelineControl(value, operation, args)).rejects.toMatchObject({
        code: 'dirty',
        message: expect.stringContaining('unsaved changes'),
      });
    const changed = await applyPipelineControl(value, 'pipeline_update', {
      ...args,
      allowDirty: true,
    });

    expect(changed.state!.workspaces[0].source).toBe(args.source);
    expect(changed.state!.workspaces[1]).toEqual(value.workspaces[1]);
    expect(value).toEqual(before);
  });

  it('deletes a selected pipeline while retaining other pipelines and engine selection', async () => {
    const value = state();
    const changed = await applyPipelineControl(value, 'pipeline_delete', {
      id: 'first',
      expectedRevision: await workspaceRevision(value.workspaces[0]),
    });

    expect(changed.result).toEqual({ deleted: 'first' });
    expect(changed.state!.workspaces).toEqual([value.workspaces[1]]);
    expect(changed.state!.activeId).toBe('unrelated');
    expect(changed.state!.engineMode).toBe('manual');
    expect(value.workspaces).toHaveLength(2);
  });

  it('rolls back a failed edit after automatic layout without discarding unrelated changes', async () => {
    const previous = state();
    const { state: proposed } = await applyPipelineControl(previous, 'pipeline_update', {
      id: 'first',
      expectedRevision: await workspaceRevision(previous.workspaces[0]),
      source: source('Failed external edit'),
    });
    const current: State = {
      ...proposed!,
      compact: false,
      workspaces: [
        {
          ...proposed!.workspaces[0],
          positions: { review: { x: 640, y: 320 } },
          updatedAt: '2026-10-21T00:01:00Z',
        },
        {
          ...proposed!.workspaces[1],
          source: `${proposed!.workspaces[1].source}\n# unrelated work`,
        },
      ],
    };
    const recovered = rollbackControlChange(previous, proposed!, current);
    expect(recovered.workspaces[0]).toEqual({
      ...previous.workspaces[0],
      positions: current.workspaces[0].positions,
    });
    expect(recovered.workspaces[1]).toEqual(current.workspaces[1]);
    expect(recovered.compact).toBe(false);
    expect(current.workspaces[0].source).toContain('Failed external edit');
  });

  it('keeps newer human-authored content when an earlier external save fails', async () => {
    const previous = state();
    const { state: proposed } = await applyPipelineControl(previous, 'pipeline_update', {
      id: 'first',
      expectedRevision: await workspaceRevision(previous.workspaces[0]),
      source: source('External edit'),
    });
    const current: State = {
      ...proposed!,
      workspaces: [
        {
          ...proposed!.workspaces[0],
          source: `${proposed!.workspaces[0].source}\n# newer human edit`,
        },
        proposed!.workspaces[1],
      ],
    };
    const recovered = rollbackControlChange(previous, proposed!, current);
    expect(recovered.workspaces).toEqual(current.workspaces);
    expect(recovered.workspaces[0].source).toContain('# newer human edit');
  });

  it.each([
    { entrypoint: '../escape.yaml' },
    { source: 7 },
    { files: [{ path: '../escape.txt', content: 'eA==' }] },
    {
      files: [
        { path: 'one.txt', content: 'eA==' },
        { path: 'ONE.txt', content: 'eA==' },
      ],
    },
    { files: [{ path: 'notes.txt', content: '!invalid-base64!' }] },
    { positions: { review: { x: null, y: 1 } } },
  ])('rejects malformed package data without changing the original: %j', async (patch) => {
    const value = state();
    const before = structuredClone(value);
    await expect(
      applyPipelineControl(value, 'pipeline_update', {
        id: 'first',
        expectedRevision: await workspaceRevision(value.workspaces[0]),
        ...patch,
      }),
    ).rejects.toThrow();
    expect(value).toEqual(before);
  });

  it('returns validation diagnostics without modifying the draft', async () => {
    const value = state();
    const before = structuredClone(value);
    const checked = await applyPipelineControl(value, 'pipeline_validate', { id: 'first' });
    expect(checked.state).toBeUndefined();
    expect(checked.result).toMatchObject({ valid: true, diagnostics: expect.any(Array) });
    value.workspaces[0].source = 'invalid: [';
    const invalid = await applyPipelineControl(value, 'pipeline_validate', { id: 'first' });
    expect(invalid.result).toMatchObject({ valid: false });
    expect(before.workspaces[0].source).toContain('External pipeline');
    expect(value.workspaces[1]).toEqual(before.workspaces[1]);
  });
});
