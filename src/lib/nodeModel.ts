import { type Graph, type Pipeline, record } from './types';

export function nodeModelSelection(
  pipeline: Pipeline,
  scope: string[],
  nodeId: string,
  connection: string,
  model = '',
  parameters?: Record<string, unknown> | null,
): { alias: string; resource: Record<string, unknown> } | undefined {
  let graph: Graph = pipeline.spec;
  for (const id of scope) {
    const node = graph.nodes[id];
    if (!node || !['foreach', 'loop'].includes(node.type)) return;

    graph = record(record(node[node.type]).body) as unknown as Graph;
  }
  const node = graph.nodes[nodeId];
  if (!node || !['llm', 'agent'].includes(node.type)) return;

  const currentAlias = String(record(node[node.type]).model ?? '');
  const models = pipeline.spec.models ?? {};
  const current = models[currentAlias] ?? {};
  const sameParameters =
    parameters === undefined ||
    (parameters === null
      ? !('parameters' in current)
      : JSON.stringify(current.parameters) === JSON.stringify(parameters));
  if (current.connection === connection && String(current.model ?? '') === model && sameParameters)
    return;

  let references = 0;

  function count(graph: Graph) {
    for (const node of Object.values(graph.nodes)) {
      const config = record(node[node.type]);
      if (['llm', 'agent'].includes(node.type) && config.model === currentAlias) references++;
      if (['foreach', 'loop'].includes(node.type)) count(config.body as Graph);
    }
  }
  count(pipeline.spec);
  let alias = currentAlias;
  if (!models[alias] || references > 1) {
    const stem = `${[...scope, nodeId].join('_')}_model`.slice(0, 60);
    alias = stem;
    let suffix = 2;
    while (models[alias]) alias = `${stem.slice(0, 58)}_${suffix++}`;
  }
  const resource: Record<string, unknown> = { ...current, connection };
  if (model) resource.model = model;
  else delete resource.model;
  if (parameters === null) delete resource.parameters;
  else if (parameters !== undefined) resource.parameters = parameters;

  return { alias, resource };
}
