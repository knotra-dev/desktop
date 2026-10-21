import { describe, expect, it } from 'vitest';
import {
  agentMcpSelection,
  effectiveAgentTools,
  mcpToolResponse,
  nodeMcpResponseDefaults,
  nodeMcpSelection,
} from '../src/lib/nodeMcp';
import type { McpTool } from '../src/lib/setup';
import type { NodeDefinition, Pipeline } from '../src/lib/types';

function pipeline(): Pipeline {
  return {
    apiVersion: 'knotra/v1',
    kind: 'Pipeline',
    metadata: { name: 'mcp-test' },
    spec: {
      mcp: { service: { connection: 'first', session: 'run' } },
      defaults: { tools: { mcp: { service: ['search'] }, sandbox: ['files.read'] } },
      nodes: {
        call: {
          type: 'tool',
          tool: { server: 'service', name: 'search', arguments: { value: {} } },
        },
        agent: {
          type: 'agent',
          agent: { model: 'writer' },
          tools: { mcp: { service: ['fetch'] }, sandbox: ['files.write'] },
        },
      },
      outputs: {},
    },
  };
}

describe('MCP block selections', () => {
  it('isolates shared server aliases without mutating defaults, agents, or session settings', () => {
    const value = pipeline();
    const before = structuredClone(value);
    expect(nodeMcpSelection(value, [], 'call', 'second')).toEqual({
      alias: 'call_mcp',
      resource: { connection: 'second', session: 'run' },
    });
    expect(value).toEqual(before);
  });

  it('reuses independent aliases and keeps unchanged aliases', () => {
    const value = pipeline();
    delete value.spec.defaults;
    delete value.spec.nodes.agent;
    expect(nodeMcpSelection(value, [], 'call', 'second')).toEqual({
      alias: 'service',
      resource: { connection: 'second', session: 'run' },
    });
    expect(nodeMcpSelection(value, [], 'call', 'first')).toEqual({
      alias: 'service',
      resource: { connection: 'first', session: 'run' },
    });
  });

  it('counts references and avoids alias collisions across nested graphs', () => {
    const value = pipeline();
    value.spec.nodes.repeat = {
      type: 'foreach',
      foreach: { body: { nodes: { call: structuredClone(value.spec.nodes.call) }, outputs: {} } },
    };
    value.spec.mcp!.repeat_call_mcp = { connection: 'reserved' };
    expect(nodeMcpSelection(value, ['repeat'], 'call', 'second')?.alias).toBe('repeat_call_mcp_2');
    expect(nodeMcpSelection(value, ['missing'], 'call', 'second')).toBeUndefined();
  });

  it('removes inherited tools explicitly while preserving code tools and other MCP grants', () => {
    const value = pipeline();
    const before = structuredClone(value);
    const result = agentMcpSelection(value, [], 'agent', 'first', 'search', false)!;
    expect(result.tools).toEqual({
      inherit: false,
      mcp: { service: ['fetch'] },
      sandbox: ['files.read', 'files.write'],
    });
    expect(value).toEqual(before);
  });

  it('respects disabled inheritance and preserves unavailable grants', () => {
    const value = pipeline();
    value.spec.nodes.agent.tools = {
      inherit: false,
      mcp: { unavailable: ['old_tool'] },
      sandbox: ['process.exec'],
    };
    expect(effectiveAgentTools(value.spec, value.spec.nodes.agent)).toEqual(
      value.spec.nodes.agent.tools,
    );
    expect(agentMcpSelection(value, [], 'agent', 'second', 'search', true)).toEqual({
      alias: 'agent_mcp',
      resource: { connection: 'second' },
      tools: {
        inherit: false,
        mcp: { unavailable: ['old_tool'], agent_mcp: ['search'] },
        sandbox: ['process.exec'],
      },
    });
  });

  it('removes duplicate grants through all aliases for the same connection only', () => {
    const value = pipeline();
    value.spec.mcp!.duplicate = { connection: 'first' };
    value.spec.mcp!.other = { connection: 'second' };
    value.spec.nodes.agent.tools = {
      mcp: { service: ['search'], duplicate: ['search'], other: ['search'] },
    };
    expect(agentMcpSelection(value, [], 'agent', 'first', 'search', false)?.tools.mcp).toEqual({
      other: ['search'],
    });
  });

  it('creates no duplicate permissions and preserves existing resource options', () => {
    const value = pipeline();
    expect(agentMcpSelection(value, [], 'agent', 'first', 'fetch', true)).toEqual({
      alias: 'service',
      resource: { connection: 'first', session: 'run' },
      tools: {
        inherit: false,
        mcp: { service: ['search', 'fetch'] },
        sandbox: ['files.read', 'files.write'],
      },
    });
  });
});

describe('MCP response selection', () => {
  const text: McpTool = { name: 'text', inputSchema: { type: 'object' } };
  const structured: McpTool = {
    name: 'report',
    inputSchema: { type: 'object' },
    outputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
  };
  const node = (): NodeDefinition => ({
    type: 'tool',
    tool: { server: 'service', name: 'search', response: 'structured' },
    outputs: { result: { schema: { type: 'object', additionalProperties: true } } },
  });

  it('chooses content arrays for ordinary MCP tools and published schemas for structured tools', () => {
    expect(mcpToolResponse(text)).toEqual({
      response: 'content',
      schema: { type: 'array', items: { type: 'object' } },
    });
    expect(mcpToolResponse(structured)).toEqual({
      response: 'structured',
      schema: structured.outputSchema,
    });
  });

  it('replaces untouched generic defaults without mutating the selected node', () => {
    const value = node();
    const before = structuredClone(value);
    expect(nodeMcpResponseDefaults(value, text)).toEqual(mcpToolResponse(text));
    expect(nodeMcpResponseDefaults(value, structured)).toEqual(mcpToolResponse(structured));
    expect(value).toEqual(before);
  });

  it('follows the previous discovered default when changing between response types', () => {
    const value = node();
    value.outputs!.result.schema = structured.outputSchema;
    expect(nodeMcpResponseDefaults(value, text, structured)).toEqual(mcpToolResponse(text));
    value.tool = { response: 'content' };
    value.outputs!.result.schema = mcpToolResponse(text).schema;
    expect(nodeMcpResponseDefaults(value, structured, text)).toEqual(mcpToolResponse(structured));
  });

  it('preserves authored schemas, references, descriptions and explicit response overrides', () => {
    const custom = node();
    custom.outputs!.result.schema = { type: 'object', required: ['authored'] };
    expect(nodeMcpResponseDefaults(custom, text)).toBeUndefined();
    const described = node();
    described.outputs!.result.description = 'An authored result';
    expect(nodeMcpResponseDefaults(described, text)).toBeUndefined();
    const referenced = node();
    referenced.outputs!.result = { schemaRef: 'AuthorSchema' };
    expect(nodeMcpResponseDefaults(referenced, text)).toBeUndefined();
    const override = node();
    override.tool = { response: 'content' };
    expect(nodeMcpResponseDefaults(override, structured)).toBeUndefined();
  });
});
