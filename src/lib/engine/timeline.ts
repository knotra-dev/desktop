import { type NodeDefinition, record } from '../types';
import {
  type Activity,
  activities,
  executionGraphs,
  mergeEvents,
  nodeForInstance,
  packageGraphs,
} from './observation';
import type { EngineEvent, EngineInstance, EngineRun } from './types';

export interface TimelineRow {
  activity: Activity;
  instance?: EngineInstance;
  node?: NodeDefinition;
  context: { nodeId: string; iterationIndex?: number }[];
  attempt?: number;
}

export function timelineNodeLabel(nodeId: string): string {
  return nodeId
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : /^[A-Z0-9]+$/.test(word)
          ? word
          : word.toLowerCase(),
    )
    .join(' ');
}

export function timelineRows(run: EngineRun, incoming: EngineEvent[]): TimelineRow[] {
  const events = mergeEvents(incoming.filter((event) => event.runId === run.id));
  const instances = new Map(run.instances.map((instance) => [instance.id, instance]));
  const attempts = new Map<string, Map<string, number>>();
  for (const event of events) {
    if (event.instanceId) {
      const data = record(event.data);
      const known = instances.get(event.instanceId);
      const nodeId = known?.nodeId || (typeof data.nodeId === 'string' ? data.nodeId : '');
      if (nodeId) {
        instances.set(event.instanceId, {
          ...known,
          id: event.instanceId,
          nodeId,
          scope: known?.scope || (typeof data.scope === 'string' ? data.scope : ''),
          status: known?.status ?? 'pending',
          graphPath: known?.graphPath || string(data.graphPath),
          nodeType: known?.nodeType || string(data.nodeType),
          parentInstanceId: known?.parentInstanceId || string(data.parentInstanceId),
          iterationIndex:
            known?.iterationIndex ??
            (typeof data.iterationIndex === 'number' ? data.iterationIndex : undefined),
        });
      }
    }
    if (event.attemptId) {
      const key = event.instanceId ?? '';
      const ownAttempts = attempts.get(key) ?? new Map<string, number>();
      if (!ownAttempts.has(event.attemptId)) {
        const number = Number(/\.a([1-9]\d*)$/.exec(event.attemptId)?.[1]);
        ownAttempts.set(
          event.attemptId,
          Number.isSafeInteger(number) && number > 0 ? number : ownAttempts.size + 1,
        );
      }
      attempts.set(key, ownAttempts);
    }
  }
  const groups = executionGraphs(
    { ...run, instances: [...instances.values()] },
    packageGraphs(run),
  );
  return activities(events).map((activity) => {
    const instance = activity.instanceId ? instances.get(activity.instanceId) : undefined;
    const context: TimelineRow['context'] = [];
    const visited = new Set(instance ? [instance.id] : []);
    let child = instance;
    while (child?.parentInstanceId && !visited.has(child.parentInstanceId)) {
      const parent = instances.get(child.parentInstanceId);
      if (!parent) break;
      visited.add(parent.id);
      context.unshift({ nodeId: parent.nodeId, iterationIndex: child.iterationIndex });
      child = parent;
    }
    if (!context.length && instance?.graphPath) {
      const parents = [...instance.graphPath.matchAll(/\/nodes\/([^/]+)\/body/g)];
      context.push(
        ...parents.map((match, index) => ({
          nodeId: match[1],
          iterationIndex: index === parents.length - 1 ? instance.iterationIndex : undefined,
        })),
      );
    }
    return {
      activity,
      instance,
      // A legacy nested instance without a path must not borrow a root node's definition.
      node:
        instance && (!instance.parentInstanceId || instance.graphPath)
          ? nodeForInstance(instance, groups)
          : undefined,
      context,
      attempt: activity.attemptId
        ? attempts.get(activity.instanceId ?? '')?.get(activity.attemptId)
        : undefined,
    };
  });
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
