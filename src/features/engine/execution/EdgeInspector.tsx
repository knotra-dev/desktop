import { ArrowRight, ChevronRight, X } from 'lucide-react';
import type { EngineInstance } from '../../../lib/engine/types';
import { useI18n } from '../../../lib/i18n';
import { DataBlock } from './DataBlock';

export interface EdgeSelection {
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
}

export function EdgeInspector({
  edge,
  instances,
  onClose,
  onSelectNode,
}: {
  edge: EdgeSelection;
  instances: Record<string, EngineInstance>;
  onClose: () => void;
  onSelectNode: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <aside
      className="execution-inspector w-[clamp(330px,_36%,_520px)] min-w-0 flex flex-col border-l border-solid border-l-line bg-surface-raised"
      aria-label={t('observe.edgeData')}
    >
      <header className="execution-inspector-heading flex justify-between items-start pt-4.25 pb-2.25 gap-2 px-4.5">
        <div>
          <small>{t('observe.edgeData')}</small>
          <h2>
            {edge.source}
            <ArrowRight size={14} />
            {edge.target}
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('observe.close')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="execution-inspector-body overflow-auto min-h-0 flex-1 p-3.75">
        <p className="muted small text-[11px] text-muted">
          {edge.sourcePort
            ? `${edge.source}.${edge.sourcePort} → ${edge.target}.${edge.targetPort}`
            : t('observe.dependencyEdge')}
        </p>
        <DataBlock
          label={t('observe.sentValue')}
          value={
            edge.sourcePort
              ? portValue(instances[edge.source]?.outputs, edge.sourcePort)
              : instances[edge.source]?.outputs
          }
          open
        />
        {edge.targetPort ? (
          <DataBlock
            label={t('observe.receivedValue')}
            value={portValue(instances[edge.target]?.inputs, edge.targetPort)}
            open
          />
        ) : null}
        <button type="button" className="button" onClick={() => onSelectNode(edge.source)}>
          {t('observe.openProducer')}
          <ChevronRight size={14} />
        </button>
      </div>
    </aside>
  );
}

function portValue(envelope: EngineInstance['inputs'], port: string): unknown {
  return envelope && Object.hasOwn(envelope.values ?? {}, port)
    ? envelope.values[port]
    : envelope?.artifacts?.[port];
}
