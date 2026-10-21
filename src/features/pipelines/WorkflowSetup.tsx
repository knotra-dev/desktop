import { Plus, Settings2, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { sources } from '../../lib/connections';
import { editorDataTypeLabel } from '../../lib/editorLabels';
import type { Resource } from '../../lib/engine/types';
import { useI18n } from '../../lib/i18n';
import type { Graph, Pipeline, Port } from '../../lib/types';
import { BindingEditor, JsonField, portDataType, seedValue } from './PortEditor';

export default function WorkflowSetup({
  pipeline,
  graph,
  imports,
  scope,
  onGraphEdit,
  onMetadata,
  onResources,
  showResources,
  engineResources,
}: {
  showResources?: 'models' | 'mcp' | 'sandboxes';
  engineResources: Resource[];
  pipeline: Pipeline;
  graph: Graph;
  imports: Map<string, Graph>;
  scope: string[];
  onGraphEdit: (key: 'inputs' | 'outputs', value: Record<string, Port>) => void;
  onMetadata: (title: string) => void;
  onResources: (
    kind: 'models' | 'mcp' | 'sandboxes',
    value: Record<string, Record<string, unknown>>,
  ) => void;
}) {
  const { t, message } = useI18n();
  const resourcePanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (showResources) resourcePanel.current?.scrollIntoView({ block: 'start' });
  }, [showResources]);
  const [input, setInput] = useState('');
  const [type, setType] = useState('string');
  const [output, setOutput] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const options = sources(graph, imports);
  const validName = (name: string, existing: Record<string, unknown>) =>
    /^[a-z][a-z0-9_]{0,63}$/.test(name) && !(name in existing);
  return (
    <aside className="inspector setup-inspector w-85 shrink-0 overflow-hidden border-l border-solid border-l-line bg-surface flex flex-col">
      <header className="inspector-header flex items-center justify-between pt-4 pb-2 px-4.5">
        <span className="text-[12px] text-secondary font-medium">
          {t(scope.length ? 'editor.bodyGraph' : 'editor.workflowSettings')}
        </span>
        <Settings2 size={16} />
      </header>
      <div className="inspector-content overflow-auto min-h-0 flex-1 px-5.25 py-6">
        {!scope.length ? (
          <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
            {t('editor.workflowTitle')}
            <input
              aria-label={t('editor.workflowTitle')}
              defaultValue={pipeline.metadata.title ?? pipeline.metadata.name}
              key={pipeline.metadata.title}
              onBlur={(event) => {
                if (event.target.value.trim()) onMetadata(event.target.value);
              }}
            />
          </label>
        ) : (
          <p className="setup-hint text-[11px] leading-[1.6] text-muted mt-0 mb-3.5 mx-0">
            {t('editor.inputsAndExportsBelongToThisBodyGraph')}
          </p>
        )}
        <section className="port-editor mb-6.5">
          <h3>{t('editor.workflowInputs')}</h3>
          <p className="setup-hint text-[11px] leading-[1.6] text-muted mt-0 mb-3.5 mx-0">
            {t('editor.startingValuesForARunBlocksCanChoose')}
          </p>
          {Object.entries(graph.inputs ?? {}).map(([name, port]) => (
            <div
              className="port-editor-card mt-0 mb-3.5 border border-solid border-line rounded-[10px] bg-base p-3.25 mx-0"
              key={name}
            >
              <div className="inline-row spread flex items-center gap-2.5 justify-between">
                <strong>{name}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('editor.removeWorkflowInputName', { name })}
                  onClick={() => {
                    const next = { ...graph.inputs };
                    delete next[name];
                    onGraphEdit('inputs', next);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {port.artifact ? (
                <small>
                  {t('editor.file')} · {port.artifact.mediaTypes.join(', ')}
                </small>
              ) : (
                <>
                  <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                    {t('editor.inputType')}
                    <select
                      value={port.schemaRef ? '$custom' : portDataType(port)}
                      onChange={(event) => {
                        const next: Port = {
                          ...port,
                          schema:
                            event.target.value === 'JSON' ? true : { type: event.target.value },
                        };
                        delete next.schemaRef;
                        if ('default' in next) next.default = seedValue(next);
                        onGraphEdit('inputs', { ...graph.inputs, [name]: next });
                      }}
                    >
                      {port.schemaRef || portDataType(port) === '$custom' ? (
                        <option value="$custom">
                          {t('editor.customSchema')}
                          {port.schemaRef ? ` · ${port.schemaRef}` : ''}
                        </option>
                      ) : null}
                      {['string', 'object', 'array', 'integer', 'number', 'boolean', 'JSON'].map(
                        (type) => (
                          <option key={type} value={type}>
                            {editorDataTypeLabel(type, t)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  {'default' in port ? (
                    <JsonField
                      label={t('editor.defaultForName', { name })}
                      value={port.default}
                      onSave={(value) =>
                        onGraphEdit('inputs', {
                          ...graph.inputs,
                          [name]: { ...port, default: value },
                        })
                      }
                      hint={t('editor.jsonValueStringsUseQuotes')}
                    />
                  ) : null}
                </>
              )}
              <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
                <summary>{t('editor.schemaDetails')}</summary>
                <pre>
                  {JSON.stringify(
                    port.schema ?? port.artifact ?? { schemaRef: port.schemaRef },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </div>
          ))}
          <div className="port-add-form border border-dashed border-line-strong rounded-[10px] p-3.25 mx-0 my-3.5">
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('editor.newWorkflowInput')}
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="topic"
              />
            </label>
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('editor.dataType')}
              <select value={type} onChange={(event) => setType(event.target.value)}>
                {['string', 'object', 'array', 'integer', 'number', 'boolean'].map((type) => (
                  <option key={type} value={type}>
                    {editorDataTypeLabel(type, t)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button small-button text-[11px] min-h-8 px-3 py-1.75"
              onClick={() => {
                if (!validName(input, graph.inputs ?? {})) {
                  setError('Choose a unique lowercase input name.');
                  return;
                }
                const port: Port = {
                  schema: { type, ...(type === 'array' ? { items: true } : {}) },
                };
                onGraphEdit('inputs', {
                  ...graph.inputs,
                  [input]: { ...port, default: seedValue(port) },
                });
                setInput('');
                setError('');
              }}
            >
              <Plus size={13} />
              {t('editor.addWorkflowInput')}
            </button>
          </div>
        </section>
        <section className="port-editor mb-6.5">
          <h3>{t('editor.workflowOutputs')}</h3>
          <p className="setup-hint text-[11px] leading-[1.6] text-muted mt-0 mb-3.5 mx-0">
            {t('editor.theResultsReturnedWhenThisGraphFinishes')}
          </p>
          {Object.entries(graph.outputs ?? {}).map(([name, port]) => (
            <div
              className="port-editor-card mt-0 mb-3.5 border border-solid border-line rounded-[10px] bg-base p-3.25 mx-0"
              key={name}
            >
              <div className="inline-row spread flex items-center gap-2.5 justify-between">
                <strong>{name}</strong>
                <button
                  type="button"
                  className="icon-button"
                  disabled={Object.keys(graph.outputs ?? {}).length <= 1}
                  aria-label={t('editor.removeWorkflowOutputName', { name })}
                  onClick={() => {
                    const next = { ...graph.outputs };
                    delete next[name];
                    onGraphEdit('outputs', next);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <BindingEditor
                name={name}
                port={port}
                graph={graph}
                imports={imports}
                onChange={(bind) =>
                  onGraphEdit('outputs', { ...graph.outputs, [name]: { ...port, bind } })
                }
              />
            </div>
          ))}
          <div className="port-add-form border border-dashed border-line-strong rounded-[10px] p-3.25 mx-0 my-3.5">
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('editor.newWorkflowOutput')}
              <input
                value={output}
                onChange={(event) => setOutput(event.target.value)}
                placeholder="result"
              />
            </label>
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('editor.exportFrom')}
              <select value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="">{t('editor.chooseAResult')}</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.node
                      ? option.label
                      : t('editor.workflowInputName', { name: option.name })}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button small-button text-[11px] min-h-8 px-3 py-1.75"
              onClick={() => {
                const origin = options.find((option) => option.value === source);
                if (!validName(output, graph.outputs ?? {}) || !origin) {
                  setError('Choose a unique output name and a source.');
                  return;
                }
                const { schema, schemaRef, artifact } = origin.port;
                onGraphEdit('outputs', {
                  ...graph.outputs,
                  [output]: {
                    ...(schema !== undefined ? { schema } : {}),
                    ...(schemaRef ? { schemaRef } : {}),
                    ...(artifact ? { artifact } : {}),
                    bind: { from: source },
                  },
                });
                setOutput('');
                setError('');
              }}
            >
              <Plus size={13} />
              {t('editor.addWorkflowOutput')}
            </button>
          </div>
        </section>
        {!scope.length ? (
          <section className="workflow-resources" ref={resourcePanel}>
            <h3>{t('navigation.resources')}</h3>
            <p className="setup-hint text-[11px] leading-[1.6] text-muted mt-0 mb-3.5 mx-0">
              {t('editor.aliasesUsedByBlocksConnectionAndProfileIds')}
            </p>
            <details open={!!showResources}>
              <summary className="cursor-pointer text-[12px] text-secondary">
                {t('resources.advancedBindings')}
              </summary>
              <p className="mt-3 text-[11px] leading-relaxed text-muted">
                {t('resources.aliasExplanation')}
              </p>
              {(['models', 'mcp', 'sandboxes'] as const).map((kind) => (
                <ResourceList
                  initiallyOpen={showResources === kind}
                  key={kind}
                  kind={kind}
                  resources={pipeline.spec[kind] ?? {}}
                  engineResources={engineResources}
                  onSave={(value) => onResources(kind, value)}
                />
              ))}
            </details>
          </section>
        ) : null}
        {error ? (
          <p
            className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
            role="alert"
          >
            {message(error)}
          </p>
        ) : null}
      </div>
    </aside>
  );
}

function ResourceList({
  kind,
  resources,
  onSave,
  initiallyOpen,
  engineResources,
}: {
  initiallyOpen?: boolean;
  kind: 'models' | 'mcp' | 'sandboxes';
  resources: Record<string, Record<string, unknown>>;
  engineResources: Resource[];
  onSave: (value: Record<string, Record<string, unknown>>) => void;
}) {
  const { t, message } = useI18n();
  const [expanded, setExpanded] = useState(!!initiallyOpen);
  useEffect(() => {
    if (initiallyOpen) setExpanded(true);
  }, [initiallyOpen]);
  const [alias, setAlias] = useState('');
  const [connection, setConnection] = useState('');
  const [error, setError] = useState('');
  const field = kind === 'sandboxes' ? 'profile' : 'connection';
  const resourceKind = kind === 'models' ? 'model' : kind === 'sandboxes' ? 'sandbox' : 'mcp';
  const available = Array.from(
    new Map(
      engineResources
        .filter((resource) => resource.kind === resourceKind && resource.status === 'available')
        .map((resource) => [resource.id, resource]),
    ).values(),
  );
  const suggestionsId = useId();
  const suggestions = available.length ? suggestionsId : undefined;
  return (
    <details
      data-tour={kind === 'models' ? 'workflow-models' : undefined}
      className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {t(
          kind === 'mcp'
            ? 'editor.mcpServers'
            : kind === 'sandboxes'
              ? 'resources.sandboxes'
              : 'resources.models',
        )}{' '}
        ({Object.keys(resources).length})
      </summary>
      {Object.entries(resources).map(([name, resource]) => (
        <div key={name}>
          <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
            {name} · {t(field === 'profile' ? 'editor.profileId' : 'editor.connectionId')}
            <input
              aria-label={`${name} · ${t(field === 'profile' ? 'editor.profileId' : 'editor.connectionId')}`}
              list={suggestions}
              defaultValue={String(resource[field])}
              key={String(resource[field])}
              onBlur={(event) => {
                const connection = event.target.value.trim();
                if (connection && connection !== resource[field]) {
                  const next = { ...resource, [field]: connection };
                  if (kind === 'models') delete next.model;
                  onSave({ ...resources, [name]: next });
                }
              }}
            />
          </label>
        </div>
      ))}
      <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
        {t(
          kind === 'models'
            ? 'editor.newModelAlias'
            : kind === 'mcp'
              ? 'editor.newServerAlias'
              : 'editor.newSandboxAlias',
        )}
        <input
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          placeholder={t('editor.eGResearcher')}
        />
      </label>
      <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
        {t(field === 'profile' ? 'editor.profileId2' : 'editor.connectionId2')}
        <input
          list={suggestions}
          value={connection}
          onChange={(event) => setConnection(event.target.value)}
          placeholder={t('editor.idInTheTrustedEngineProfile')}
        />
      </label>
      <datalist id={suggestionsId}>
        {available.map((resource) => (
          <option key={resource.id} value={resource.id} label={resource.title} />
        ))}
      </datalist>
      <button
        type="button"
        className="button small-button text-[11px] min-h-8 px-3 py-1.75"
        onClick={() => {
          if (
            !/^[a-z][a-z0-9_]{0,63}$/.test(alias) ||
            resources[alias] ||
            !/^[a-z][a-z0-9_]{0,63}$/.test(connection)
          ) {
            setError('Use unique lowercase identifiers for the alias and engine ID.');
            return;
          }
          onSave({ ...resources, [alias]: { [field]: connection } });
          setAlias('');
          setConnection('');
          setError('');
        }}
      >
        <Plus size={13} />
        {t('editor.addAlias')}
      </button>
      {error ? (
        <p
          className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
          role="alert"
        >
          {message(error)}
        </p>
      ) : null}
    </details>
  );
}
