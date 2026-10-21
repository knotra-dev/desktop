import type { McpTool } from './setup';
import { type DataSchema, type Graph, type NodeDefinition, type Pipeline, record } from './types';

export function mcpToolResponse(tool?: McpTool): {
  response: 'structured' | 'content';
  schema: DataSchema;
} {
  return tool?.outputSchema
    ? { response: 'structured', schema: tool.outputSchema }
    : { response: 'content', schema: { type: 'array', items: { type: 'object' } } };
}

export function nodeMcpResponseDefaults(
  node: NodeDefinition,
  tool?: McpTool,
  previous?: McpTool,
): ReturnType<typeof mcpToolResponse> | undefined {
  if (node.type !== 'tool' || Object.keys(node.outputs ?? {}).join() !== 'result') return;
  const port = node.outputs?.result;
  if (!port || Object.keys(port).join() !== 'schema') return;
  const schema = record(port.schema);
  const response = record(node.tool).response ?? 'structured';
  const genericObject =
    response === 'structured' &&
    schema.type === 'object' &&
    Object.keys(schema).every((key) => key === 'type' || key === 'additionalProperties') &&
    (!('additionalProperties' in schema) || schema.additionalProperties === true);
  const prior = mcpToolResponse(previous);
  const priorDefault =
    response === prior.response && JSON.stringify(port.schema) === JSON.stringify(prior.schema);
  if (!genericObject && !priorDefault) return;
  return mcpToolResponse(tool);
}

function scopedNode(
  pipeline: Pipeline,
  scope: string[],
  nodeId: string,
): NodeDefinition | undefined {
  let graph: Graph = pipeline.spec;
  for (const id of scope) {
    const node = graph.nodes[id];
    if (!node || !['foreach', 'loop'].includes(node.type)) return;
    graph = record(record(node[node.type]).body) as unknown as Graph;
  }
  return graph.nodes[nodeId];
}

function availableAlias(pipeline: Pipeline, scope: string[], nodeId: string): string {
  const stem = `${[...scope, nodeId].join('_')}_mcp`.slice(0, 60);
  let alias = stem;
  let suffix = 2;
  while (pipeline.spec.mcp?.[alias]) alias = `${stem.slice(0, 58)}_${suffix++}`;
  return alias;
}

export function nodeMcpSelection(
  pipeline: Pipeline,
  scope: string[],
  nodeId: string,
  connection: string,
): { alias: string; resource: Record<string, unknown> } | undefined {
  const node = scopedNode(pipeline, scope, nodeId);
  if (node?.type !== 'tool') return;
  const currentAlias = String(record(node.tool).server ?? '');
  const current = pipeline.spec.mcp?.[currentAlias] ?? {};
  if (current.connection === connection) return { alias: currentAlias, resource: current };

  let references = Object.hasOwn(record(pipeline.spec.defaults?.tools?.mcp), currentAlias) ? 1 : 0;
  function count(graph: Graph) {
    for (const node of Object.values(graph.nodes)) {
      const config = record(node[node.type]);
      if (node.type === 'tool' && config.server === currentAlias) references++;
      if (Object.hasOwn(record(record(node.tools).mcp), currentAlias)) references++;
      if (['foreach', 'loop'].includes(node.type)) count(config.body as Graph);
    }
  }
  count(pipeline.spec);
  const alias =
    !pipeline.spec.mcp?.[currentAlias] || references > 1
      ? availableAlias(pipeline, scope, nodeId)
      : currentAlias;
  return { alias, resource: { ...current, connection } };
}

export function effectiveAgentTools(
  resources: Pipeline['spec'],
  node: NodeDefinition,
): Record<string, unknown> {
  const own = record(node.tools);
  const defaults = own.inherit === false ? {} : record(resources.defaults?.tools);
  const mcp: Record<string, string[]> = {};
  for (const grants of [record(defaults.mcp), record(own.mcp)]) {
    for (const [alias, names] of Object.entries(grants)) {
      if (Array.isArray(names)) mcp[alias] = [...new Set([...(mcp[alias] ?? []), ...names])];
    }
  }
  const sandbox = [
    ...new Set([
      ...(Array.isArray(defaults.sandbox) ? defaults.sandbox : []),
      ...(Array.isArray(own.sandbox) ? own.sandbox : []),
    ]),
  ];
  return { ...own, inherit: false, mcp, sandbox };
}

export function agentMcpSelection(
  pipeline: Pipeline,
  scope: string[],
  nodeId: string,
  connection: string,
  tool: string,
  enabled: boolean,
):
  | { tools: Record<string, unknown>; alias?: string; resource?: Record<string, unknown> }
  | undefined {
  const node = scopedNode(pipeline, scope, nodeId);
  if (node?.type !== 'agent') return;
  // Materialize inherited grants so unchecking one MCP tool does not remove sandbox permissions.
  const tools = effectiveAgentTools(pipeline.spec, node);
  const mcp = tools.mcp as Record<string, string[]>;
  const aliases = Object.keys(pipeline.spec.mcp ?? {}).filter(
    (alias) => pipeline.spec.mcp?.[alias].connection === connection,
  );
  if (!enabled) {
    for (const alias of aliases) {
      if (mcp[alias]) mcp[alias] = mcp[alias].filter((name) => name !== tool);
      if (!mcp[alias]?.length) delete mcp[alias];
    }
    return { tools };
  }
  const alias =
    aliases.find((alias) => mcp[alias]) ?? aliases[0] ?? availableAlias(pipeline, scope, nodeId);
  mcp[alias] = [...new Set([...(mcp[alias] ?? []), tool])];
  return { tools, alias, resource: pipeline.spec.mcp?.[alias] ?? { connection } };
}
