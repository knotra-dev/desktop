import { describe, expect, it } from 'vitest';
import { nodeModelSelection } from '../src/lib/nodeModel';
import type { NodeDefinition, Pipeline } from '../src/lib/types';

function llm(model = 'shared'): NodeDefinition {
  return { type: 'llm', llm: { model, prompt: { text: 'Answer.' } } };
}
function pipeline(): Pipeline {
  return {
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: { name: 'test' },
    spec: {
      nodes: { first: llm(), second: llm() },
      outputs: {},
      models: {
        shared: {
          connection: 'api',
          model: 'fast',
          requires: ['structuredOutput'],
          parameters: { temperature: 0.2 },
        },
      },
    },
  };
}

describe('per-node model selection', () => {
  it('copies shared aliases without changing the other node or resource settings', () => {
    const value = pipeline();
    const before = structuredClone(value);
    expect(nodeModelSelection(value, [], 'first', 'claude', 'reasoning')).toEqual({
      alias: 'first_model',
      resource: {
        connection: 'claude',
        model: 'reasoning',
        requires: ['structuredOutput'],
        parameters: { temperature: 0.2 },
      },
    });
    expect(value).toEqual(before);
  });

  it('reuses an independent alias and can return to the source default', () => {
    const value = pipeline();
    delete value.spec.nodes.second;
    expect(nodeModelSelection(value, [], 'first', 'api')).toEqual({
      alias: 'shared',
      resource: {
        connection: 'api',
        requires: ['structuredOutput'],
        parameters: { temperature: 0.2 },
      },
    });
  });

  it('counts shared aliases throughout nested body graphs', () => {
    const value = pipeline();
    value.spec.nodes.second = {
      type: 'foreach',
      foreach: { body: { nodes: { first: llm() }, outputs: {} } },
    };
    expect(nodeModelSelection(value, ['second'], 'first', 'codex', 'code')?.alias).toBe(
      'second_first_model',
    );
    expect(nodeModelSelection(value, [], 'first', 'api', 'new')?.alias).toBe('first_model');
  });

  it('does not overwrite a colliding alias and limits generated identifiers', () => {
    const value = pipeline();
    value.spec.models!.first_model = { connection: 'other' };
    expect(nodeModelSelection(value, [], 'first', 'codex')?.alias).toBe('first_model_2');
    const long = 'a'.repeat(64);
    value.spec.nodes[long] = llm();
    expect(nodeModelSelection(value, [], long, 'codex')!.alias).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });

  it('preserves legacy aliases until the user changes a selection', () => {
    expect(nodeModelSelection(pipeline(), [], 'first', 'api', 'fast')).toBeUndefined();
  });

  it('creates a binding for a node with no declared alias', () => {
    const value = pipeline();
    value.spec.nodes.new_node = { type: 'agent', agent: { model: 'missing' } };
    expect(nodeModelSelection(value, [], 'new_node', 'api', 'fast')).toEqual({
      alias: 'new_node_model',
      resource: { connection: 'api', model: 'fast' },
    });
  });

  it('isolates parameter-only edits while retaining the model and resource requirements', () => {
    const value = pipeline();
    const before = structuredClone(value);
    expect(nodeModelSelection(value, [], 'first', 'api', 'fast', { temperature: 0.7 })).toEqual({
      alias: 'first_model',
      resource: {
        connection: 'api',
        model: 'fast',
        requires: ['structuredOutput'],
        parameters: { temperature: 0.7 },
      },
    });
    expect(value).toEqual(before);
  });

  it('isolates an explicit parameter reset without changing the shared alias', () => {
    const value = pipeline();
    const before = structuredClone(value);
    expect(nodeModelSelection(value, [], 'second', 'api', 'fast', null)).toEqual({
      alias: 'second_model',
      resource: {
        connection: 'api',
        model: 'fast',
        requires: ['structuredOutput'],
      },
    });
    expect(value).toEqual(before);
  });

  it('does not clone an unchanged parameter selection or an already cleared override', () => {
    const value = pipeline();
    expect(
      nodeModelSelection(value, [], 'first', 'api', 'fast', { temperature: 0.2 }),
    ).toBeUndefined();
    delete value.spec.models!.shared.parameters;
    expect(nodeModelSelection(value, [], 'first', 'api', 'fast', null)).toBeUndefined();
  });

  it('can retain an explicit empty override or clear an independent node override', () => {
    const value = pipeline();
    delete value.spec.nodes.second;
    expect(nodeModelSelection(value, [], 'first', 'api', 'fast', {})).toEqual({
      alias: 'shared',
      resource: {
        connection: 'api',
        model: 'fast',
        requires: ['structuredOutput'],
        parameters: {},
      },
    });
    expect(nodeModelSelection(value, [], 'first', 'api', 'fast', null)).toEqual({
      alias: 'shared',
      resource: {
        connection: 'api',
        model: 'fast',
        requires: ['structuredOutput'],
      },
    });
  });
});
