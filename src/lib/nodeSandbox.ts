import { effectiveAgentTools } from './nodeMcp';
import { type Graph, type NodeDefinition, type Pipeline, record } from './types';

export function nodeSandboxSelection(
  pipeline: Pipeline,
  scope: string[],
  nodeId: string,
  profile: string,
): { alias: string; resource: Record<string, unknown> } | undefined {
  let graph: Graph = pipeline.spec;
  for (const id of scope) {
    const node = graph.nodes[id];
    if (!node || !['foreach', 'loop'].includes(node.type)) return;
    graph = record(record(node[node.type]).body) as unknown as Graph;
  }
  const node = graph.nodes[nodeId];
  if (!node || !['agent', 'code'].includes(node.type)) return;
  const currentAlias = node.sandbox ?? '';
  const sandboxes = pipeline.spec.sandboxes ?? {};
  const current = sandboxes[currentAlias] ?? {};
  if (current.profile === profile) return;

  let references = 0;
  function count(graph: Graph) {
    for (const node of Object.values(graph.nodes)) {
      if (node.sandbox === currentAlias) references++;
      const config = record(node[node.type]);
      if (
        node.type === 'pipeline' &&
        Array.isArray(record(config.permissions).sandboxes) &&
        (record(config.permissions).sandboxes as unknown[]).includes(currentAlias)
      )
        references++;
      if (['foreach', 'loop'].includes(node.type)) count(config.body as Graph);
    }
  }
  count(pipeline.spec);
  let alias = currentAlias;
  if (!sandboxes[alias] || references > 1) {
    const stem = `${[...scope, nodeId].join('_')}_sandbox`.slice(0, 60);
    alias = stem;
    let suffix = 2;
    while (sandboxes[alias]) alias = `${stem.slice(0, 58)}_${suffix++}`;
  }
  return { alias, resource: { ...current, profile } };
}

export function agentSandboxPermission(
  resources: Pipeline['spec'],
  node: NodeDefinition,
  permission: string,
  enabled: boolean,
): Record<string, unknown> {
  const tools = effectiveAgentTools(resources, node);
  const sandbox = tools.sandbox as string[];
  return {
    ...tools,
    sandbox: enabled
      ? [...new Set([...sandbox, permission])]
      : sandbox.filter((value) => value !== permission),
  };
}
