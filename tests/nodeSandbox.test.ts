import { describe, expect, it } from 'vitest';
import { agentSandboxPermission, nodeSandboxSelection } from '../src/lib/nodeSandbox';
import type { NodeDefinition, Pipeline } from '../src/lib/types';

function code(sandbox = 'work'): NodeDefinition {
  return { type: 'code', sandbox, code: { command: ['python3', '-c', 'print(1)'] } };
}

function pipeline(): Pipeline {
  return {
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: { name: 'test' },
    spec: {
      nodes: { first: code(), second: code() },
      outputs: {},
      sandboxes: {
        work: {
          profile: 'python_box',
          mounts: [{ source: 'data', target: '/data' }],
          workDir: '/project',
          requires: ['process.exec'],
        },
      },
    },
  };
}

describe('per-node sandbox selection', () => {
  it('copies a shared environment without changing other blocks or binding metadata', () => {
    const value = pipeline();
    const before = structuredClone(value);
    expect(nodeSandboxSelection(value, [], 'first', 'node_box')).toEqual({
      alias: 'first_sandbox',
      resource: { ...value.spec.sandboxes!.work, profile: 'node_box' },
    });
    expect(value).toEqual(before);
  });

  it('retains an independent alias and preserves its settings', () => {
    const value = pipeline();
    delete value.spec.nodes.second;
    expect(nodeSandboxSelection(value, [], 'first', 'node_box')).toEqual({
      alias: 'work',
      resource: { ...value.spec.sandboxes!.work, profile: 'node_box' },
    });
  });

  it('counts code and agent references in nested scopes', () => {
    const value = pipeline();
    value.spec.nodes.second = {
      type: 'foreach',
      foreach: { body: { nodes: { inner: { type: 'agent', sandbox: 'work' } }, outputs: {} } },
    };
    expect(nodeSandboxSelection(value, ['second'], 'inner', 'node_box')?.alias).toBe(
      'second_inner_sandbox',
    );
    expect(nodeSandboxSelection(value, [], 'first', 'node_box')?.alias).toBe('first_sandbox');
  });

  it('does not mutate a resource delegated to an imported pipeline', () => {
    const value = pipeline();
    value.spec.nodes.second = {
      type: 'pipeline',
      pipeline: { file: 'child.yaml', permissions: { sandboxes: ['work'] } },
    };
    expect(nodeSandboxSelection(value, [], 'first', 'node_box')?.alias).toBe('first_sandbox');
  });

  it('does nothing for an unchanged saved environment, including offline bindings', () => {
    expect(nodeSandboxSelection(pipeline(), [], 'first', 'python_box')).toBeUndefined();
  });

  it('avoids colliding aliases and bounds generated names', () => {
    const value = pipeline();
    value.spec.sandboxes!.first_sandbox = { profile: 'other' };
    expect(nodeSandboxSelection(value, [], 'first', 'node_box')?.alias).toBe('first_sandbox_2');
    const long = 'a'.repeat(64);
    value.spec.nodes[long] = code();
    expect(nodeSandboxSelection(value, [], long, 'node_box')?.alias).toMatch(
      /^[a-z][a-z0-9_]{0,63}$/,
    );
  });

  it('creates missing declarations only after a selection and ignores unsupported nodes', () => {
    const value = pipeline();
    value.spec.nodes.first = code('missing');
    expect(nodeSandboxSelection(value, [], 'first', 'node_box')).toEqual({
      alias: 'first_sandbox',
      resource: { profile: 'node_box' },
    });
    value.spec.nodes.second = { type: 'llm' };
    expect(nodeSandboxSelection(value, [], 'second', 'node_box')).toBeUndefined();
    expect(nodeSandboxSelection(value, ['first'], 'first', 'node_box')).toBeUndefined();
  });
});

describe('agent sandbox permissions', () => {
  it('materializes inherited grants while preserving MCP and unknown sandbox grants', () => {
    const value = pipeline();
    value.spec.defaults = {
      tools: { sandbox: ['files.read'], mcp: { service: ['search'] } },
    };
    const node: NodeDefinition = {
      type: 'agent',
      tools: { sandbox: ['custom.tool'], mcp: { other: ['save'] }, custom: 'keep' },
    };
    const before = structuredClone({ value, node });
    expect(agentSandboxPermission(value.spec, node, 'files.read', false)).toEqual({
      inherit: false,
      sandbox: ['custom.tool'],
      mcp: { service: ['search'], other: ['save'] },
      custom: 'keep',
    });
    expect({ value, node }).toEqual(before);
  });

  it('respects explicit inheritance and avoids duplicate permissions', () => {
    const value = pipeline();
    value.spec.defaults = { tools: { sandbox: ['files.read'] } };
    const node: NodeDefinition = {
      type: 'agent',
      tools: { inherit: false, sandbox: ['process.exec'] },
    };
    expect(agentSandboxPermission(value.spec, node, 'process.exec', true)).toEqual({
      inherit: false,
      sandbox: ['process.exec'],
      mcp: {},
    });
    expect(agentSandboxPermission(value.spec, node, 'files.write', true).sandbox).toEqual([
      'process.exec',
      'files.write',
    ]);
  });
});
