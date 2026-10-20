import dagre from '@dagrejs/dagre';
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { Check, CircleDot, UserRound, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { connectionError, type PortConnection } from '../../lib/connections';
import { editorDirectionKeys, editorPortTypeLabel, editorStatusKeys } from '../../lib/editorLabels';
import { dependencies, nodePorts } from '../../lib/graph';
import { useI18n } from '../../lib/i18n';
import { useTheme } from '../../lib/theme';
import {
  type Graph,
  type NodeDefinition,
  type NodeStatus,
  type Port,
  record,
} from '../../lib/types';
import { NodeIcon, nodeMeta } from '../ui';

interface LayoutData extends Record<string, unknown> {
  id: string;
  node: NodeDefinition;
  status?: NodeStatus;
  observation?: string;
  outputs: Record<string, Port>;
  editable: boolean;
  compact: boolean;
}

interface CardData extends LayoutData {
  choosePort: (node: string, port: string, source: boolean) => void;
}

type CardNode = Node<CardData, 'pipelineNode'>;
type LayoutNode = Node<LayoutData, 'pipelineNode'>;

function nodeDetail(node: NodeDefinition, t: ReturnType<typeof useI18n>['t']): string {
  const config = record(node[node.type]);
  if (config.model)
    return `${config.model} · ${config.maxSteps ? t('editor.countSteps', { count: String(config.maxSteps) }) : t('editor.structuredOutput')}`;
  if (node.type === 'tool') return `${config.server}.${config.name}`;
  if (node.type === 'human') return t('editor.waitsForAPerson');
  if (node.type === 'code')
    return `${Array.isArray(config.command) ? config.command[0] : t('editor.command')} · ${node.sandbox ?? t('editor.sandbox2')}`;
  if (node.type === 'foreach')
    return t('editor.countConcurrentIterations', { count: String(config.concurrency) });
  if (node.type === 'loop')
    return t('editor.countMaximumIterations', { count: String(config.maxIterations) });
  if (node.type === 'pipeline') return String(config.file);
  return t('editor.conditionalRouting');
}

function PipelineCard({ data, selected }: NodeProps<CardNode>) {
  const { t } = useI18n();
  const meta = nodeMeta[data.node.type];
  const inputs = Object.entries(data.node.inputs ?? {});
  const outputs = Object.entries(data.outputs);
  const renderPort = ([name, port]: [string, Port], source: boolean) => (
    <div
      className={`canvas-port relative min-h-7 flex flex-col justify-center gap-0.5 ${source ? 'canvas-output text-right' : 'canvas-input'}`}
      key={name}
    >
      <Handle
        id={`${source ? 'output' : 'input'}:${name}`}
        type={source ? 'source' : 'target'}
        position={source ? Position.Right : Position.Left}
        isConnectable={data.editable}
        role={data.editable ? 'button' : undefined}
        tabIndex={data.editable ? 0 : -1}
        aria-label={t(source ? 'editor.nodeOutputName' : 'editor.nodeInputName', {
          node: data.id,
          name,
        })}
        title={`${t(source ? 'editor.dragFromThisOutput' : 'editor.dropAnOutputHere')} · ${name} (${editorPortTypeLabel(port, t)})`}
        onClick={(event) => {
          if (data.editable) {
            event.stopPropagation();
            data.choosePort(data.id, name, source);
          }
        }}
        onKeyDown={(event) => {
          if (data.editable && ['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            data.choosePort(data.id, name, source);
          }
        }}
      />
      <span title={`${name} · ${editorPortTypeLabel(port, t)}`}>{name}</span>
      <small>{editorPortTypeLabel(port, t)}</small>
    </div>
  );
  return (
    <div
      className={`flow-card port-card w-61 min-h-41.5 border border-solid border-line-strong rounded-[14px] bg-surface-raised text-foreground [transition:border-color_0.15s] relative [--node-color:var(--accent)] p-4.25 ${data.compact ? 'run-port-card' : ''} node-color-${meta.color} ${selected ? 'flow-card-selected' : ''} ${data.status ? `execution-node-${data.status}` : ''}`}
    >
      <Handle
        id="dependency-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="dependency-handle"
      />
      <Handle
        id="dependency-out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="dependency-handle"
      />
      <div className="flow-card-top flex items-center gap-2.25 mb-3.25">
        <span className={`node-icon tint-${meta.color}`}>
          <NodeIcon kind={data.node.type} size={17} />
        </span>
        <span className="node-kind text-[12px] text-secondary">{t(meta.label)}</span>
        {data.status ? (
          <span
            className={`node-state ml-auto flex text-secondary state-${data.status}`}
            title={t(editorStatusKeys[data.status])}
          >
            {data.status === 'succeeded' ? (
              <Check size={14} />
            ) : data.status === 'waiting_human' ? (
              <UserRound size={14} />
            ) : (
              <CircleDot size={14} />
            )}
          </span>
        ) : null}
      </div>
      <strong>{data.id.replace(/_/g, ' ')}</strong>
      <p className="node-summary">{nodeDetail(data.node, t)}</p>
      {data.status ? (
        <div
          className={`execution-node-caption mt-1 mb-2.5 flex flex-col gap-1 text-[10px] mx-0 state-${data.status}`}
          title={data.observation}
        >
          <span>{t(editorStatusKeys[data.status])}</span>
          {data.observation ? <small>{data.observation}</small> : null}
        </div>
      ) : null}
      <div className="canvas-ports grid grid-cols-[1fr_1fr] gap-2.5 mt-3 pt-2.5 border-t border-solid border-t-line">
        <div>
          <span className="port-caption block text-[8px] tracking-[0.9px] text-muted mb-1.25">
            {t('editor.inputs')}
          </span>
          {inputs.length ? (
            inputs.map((port) => renderPort(port, false))
          ) : (
            <small className="port-none">{t('editor.noInputs')}</small>
          )}
        </div>
        <div>
          <span className="port-caption block text-[8px] tracking-[0.9px] text-muted mb-1.25">
            {t('editor.outputs')}
          </span>
          {outputs.map((port) => renderPort(port, true))}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = { pipelineNode: PipelineCard };
const WIDTH = 236;

function FitNewBlocks({
  count,
  container,
}: {
  count: number;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const fitted = useRef('');
  useEffect(() => {
    const viewport = container.current?.querySelector('.react-flow');
    if (!initialized || !count || !viewport) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = viewport.getBoundingClientRect();
        const key = `${count}:${bounds.width}:${bounds.height}`;
        if (!bounds.width || !bounds.height || fitted.current === key) return;
        fitted.current = key;
        void fitView({ padding: 0.06, maxZoom: 1, duration: 0 });
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [initialized, count, fitView, container]);
  return null;
}

export default function GraphView({
  graph,
  selected,
  onSelect,
  statuses,
  observations,
  onSelectEdge,
  onOpenBody,
  importedGraphs,
  onConnect,
  onNotify,
  positions,
  onMove,
  onLayout,
}: {
  graph: Graph;
  selected?: string;
  onSelect: (id: string) => void;
  statuses?: Record<string, NodeStatus>;
  observations?: Record<string, string>;
  onSelectEdge?: (edge: {
    source: string;
    target: string;
    sourcePort?: string;
    targetPort?: string;
  }) => void;
  importedGraphs?: Map<string, Graph>;
  positions?: Record<string, { x: number; y: number }>;
  onMove?: (id: string, position: { x: number; y: number }) => void;
  onLayout?: (positions: Record<string, { x: number; y: number }>) => void;
  onOpenBody?: (id: string) => void;
  onConnect?: (connection: PortConnection) => void;
  onNotify?: (message: string) => void;
}) {
  const { t, message } = useI18n();
  const canvas = useRef<HTMLDivElement>(null);
  const defaultPositions = useRef<Record<string, { x: number; y: number }>>({});
  const theme = useTheme();
  const [pending, setPending] = useState<{ node: string; port: string }>();
  const connect = useCallback(
    (connection: Connection) => {
      if (
        !connection.sourceHandle?.startsWith('output:') ||
        !connection.targetHandle?.startsWith('input:')
      )
        return;
      const ports = {
        source: connection.source,
        target: connection.target,
        sourcePort: connection.sourceHandle.slice(7),
        targetPort: connection.targetHandle.slice(6),
      };
      const error = connectionError(graph, ports, importedGraphs);
      if (error) onNotify?.(message(error));
      else onConnect?.(ports);
      setPending(undefined);
    },
    [graph, importedGraphs, message, onConnect, onNotify],
  );
  const choosePort = useCallback(
    (node: string, port: string, source: boolean) => {
      if (source) setPending({ node, port });
      else if (pending)
        connect({
          source: pending.node,
          sourceHandle: `output:${pending.port}`,
          target: node,
          targetHandle: `input:${port}`,
        });
      else {
        onSelect(node);
        onNotify?.(t('editor.startAtAnOutputDotThenDragTo'));
      }
    },
    [connect, onNotify, onSelect, pending, t],
  );
  const editable = !!onConnect;
  const { nodes: layoutNodes, edges } = useMemo(() => {
    const width = editable ? WIDTH : 188;
    const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    layout.setGraph({ rankdir: 'LR', nodesep: 75, ranksep: editable ? 95 : 60 });
    const entries = Object.entries(graph.nodes);
    const height = (node: NodeDefinition) =>
      (statuses ? 184 : 132) +
      Math.max(
        Object.keys(node.inputs ?? {}).length,
        Object.keys(nodePorts(node, importedGraphs)).length,
        1,
      ) *
        28;
    for (const [id, node] of entries) layout.setNode(id, { width, height: height(node) });
    const edges: Edge[] = [];
    for (const [id, node] of entries) {
      const represented = new Set<string>();
      const addEdge = (
        dep: string,
        sourceHandle: string,
        targetHandle: string,
        suffix: string,
        indirect = false,
      ) => {
        if (!graph.nodes[dep]) return;
        layout.setEdge(dep, id);
        const highlighted = id === selected || dep === selected;
        const color =
          statuses?.[dep] === 'succeeded' || highlighted
            ? theme === 'light'
              ? '#247653'
              : '#a1dec4'
            : theme === 'light'
              ? '#89978e'
              : '#777e79';
        edges.push({
          id: `${dep}-${id}-${suffix}`,
          source: dep,
          target: id,
          ariaLabel: t('editor.edgeDescription', { source: dep, target: id }),
          sourceHandle,
          targetHandle,
          type: 'smoothstep',
          animated: statuses?.[id] === 'running' && statuses?.[dep] === 'succeeded',
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
          style: {
            stroke: color,
            strokeWidth: highlighted ? 2 : 1.5,
            strokeDasharray: indirect ? '5 4' : undefined,
            opacity: statuses?.[id] === 'skipped' || statuses?.[dep] === 'skipped' ? 0.3 : 1,
          },
        });
      };
      for (const [name, port] of Object.entries(node.inputs ?? {})) {
        const match = port.bind?.from?.match(
          /^nodes\.([a-z][a-z0-9_]*)\.outputs\.([a-z][a-z0-9_]*)$/,
        );
        if (
          match &&
          graph.nodes[match[1]] &&
          nodePorts(graph.nodes[match[1]], importedGraphs)[match[2]]
        ) {
          addEdge(match[1], `output:${match[2]}`, `input:${name}`, name);
          represented.add(match[1]);
        }
      }
      for (const dep of dependencies(node))
        if (!represented.has(dep))
          addEdge(dep, 'dependency-out', 'dependency-in', 'dependency', true);
    }
    dagre.layout(layout);
    const research =
      editable &&
      ['discover', 'research', 'draft', 'review', 'publish'].every((id) => graph.nodes[id]);
    const researchPositions: Record<string, { x: number; y: number }> = {
      discover: { x: 0, y: 0 },
      research: { x: 312, y: 0 },
      draft: { x: 624, y: 0 },
      review: { x: 312, y: 300 },
      publish: { x: 624, y: 300 },
    };
    const placed = { ...defaultPositions.current, ...positions };
    const hasSavedLayout = entries.some(([id]) => placed[id]);
    for (const [id, node] of entries) {
      if (placed[id]) continue;
      let position =
        researchPositions[id] && research
          ? researchPositions[id]
          : { x: layout.node(id).x - width / 2, y: layout.node(id).y - height(node) / 2 };
      // Wiring changes must never move existing blocks. Place new blocks in a vacant grid cell.
      if ((hasSavedLayout || research) && !(research && researchPositions[id])) {
        let row = research ? 1 : 0;
        let column = 0;
        while (true) {
          position = { x: column * 312, y: row * 300 };
          if (
            !Object.entries(placed).some(
              ([key, point]) =>
                graph.nodes[key] &&
                Math.abs(point.x - position.x) < WIDTH + 40 &&
                point.y < position.y + height(node) + 40 &&
                point.y + height(graph.nodes[key]) + 40 > position.y,
            )
          )
            break;
          if (++column === 3) {
            column = 0;
            row++;
          }
        }
      }
      placed[id] = position;
      defaultPositions.current[id] = position;
    }
    const nodes: LayoutNode[] = entries.map(([id, node]) => ({
      id,
      type: 'pipelineNode',
      selected: id === selected,
      position: placed[id],
      data: {
        id,
        node,
        status: statuses?.[id],
        observation: observations?.[id],
        outputs: nodePorts(node, importedGraphs),
        editable,
        compact: !editable,
      },
    }));
    return { nodes, edges };
  }, [graph, selected, statuses, observations, importedGraphs, theme, editable, positions, t]);
  const nodes = useMemo(
    () => layoutNodes.map((node) => ({ ...node, data: { ...node.data, choosePort } })),
    [layoutNodes, choosePort],
  );
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<CardNode>([]);
  useEffect(() => setFlowNodes(nodes), [nodes, setFlowNodes]);
  useEffect(() => {
    const missing = Object.fromEntries(
      nodes.filter((node) => !positions?.[node.id]).map((node) => [node.id, node.position]),
    );
    if (Object.keys(missing).length) onLayout?.(missing);
  }, [nodes, positions, onLayout]);
  return (
    <div
      className="graph-view flex-1 min-w-0 relative bg-surface overflow-hidden [isolation:isolate] flex flex-col"
      ref={canvas}
    >
      {pending ? (
        <div
          className="connection-prompt relative z-2 flex items-center justify-between gap-2 text-[11px] text-secondary bg-accent-surface border-b border-solid border-b-line px-3 py-1.75"
          role="status"
        >
          <span>
            <strong>
              {pending.node}.{pending.port}
            </strong>{' '}
            {t('editor.selectedClickAnInputDotToConnect')}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={t('editor.cancelConnection')}
            onClick={() => setPending(undefined)}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      <ReactFlow
        nodes={flowNodes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => onMove?.(node.id, node.position)}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={theme}
        fitView
        fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.5}
        nodesDraggable={!!onConnect}
        nodesConnectable={!!onConnect}
        connectOnClick={false}
        onConnect={connect}
        onNodeClick={(_, node) => onSelect(node.id)}
        onNodeDoubleClick={(_, node) => onOpenBody?.(node.id)}
        onEdgeClick={(_, edge) =>
          onSelectEdge?.({
            source: edge.source,
            target: edge.target,
            sourcePort: edge.sourceHandle?.startsWith('output:')
              ? edge.sourceHandle.slice(7)
              : undefined,
            targetPort: edge.targetHandle?.startsWith('input:')
              ? edge.targetHandle.slice(6)
              : undefined,
          })
        }
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{
          'controls.zoomIn.ariaLabel': t('editor.zoomIn'),
          'controls.zoomOut.ariaLabel': t('editor.zoomOut'),
          'controls.fitView.ariaLabel': t('editor.fitGraph'),
          'controls.ariaLabel': t('editor.graphControls'),
          'node.a11yDescription.default': t('editor.pressEnterOrSpaceToSelectANode'),
          'node.a11yDescription.keyboardDisabled': t('editor.pressEnterOrSpaceToSelectANode2'),
          'edge.a11yDescription.default': t('editor.pressEnterOrSpaceToSelectAnEdge'),
          'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) =>
            t('editor.movedSelectedNodeDirectionNewPositionXX', {
              direction: t(editorDirectionKeys[direction]),
              x,
              y,
            }),
          'handle.ariaLabel': t('editor.port'),
        }}
      >
        <FitNewBlocks count={flowNodes.length} container={canvas} />
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color={theme === 'light' ? '#cdd6cf' : '#333333'}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
