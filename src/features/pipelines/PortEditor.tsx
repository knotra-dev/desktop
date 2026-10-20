import { Link2, Plus, Trash2, Unplug } from 'lucide-react';
import { useState } from 'react';
import { compatible, connectionError, sources } from '../../lib/connections';
import { editorDataTypeLabel, editorPortTypeLabel } from '../../lib/editorLabels';
import { useI18n } from '../../lib/i18n';
import {
  type Binding,
  type DataSchema,
  type Graph,
  type Json,
  type Port,
  record,
} from '../../lib/types';

export function seedValue(port: Port): Json {
  const schema = record(port.schema);
  if (Array.isArray(schema.enum)) return schema.enum[0] as Json;
  switch (schema.type) {
    case 'integer':
    case 'number':
      return Number(schema.minimum ?? 0);
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'null':
      return null;
    default:
      return '';
  }
}

export function portDataType(port: Port): string {
  if (port.artifact) return 'file';
  if (port.schemaRef) return 'reference';
  const schema = record(port.schema);
  return typeof schema.type === 'string'
    ? schema.type
    : port.schema === false || Object.keys(schema).length
      ? '$custom'
      : 'JSON';
}

export function JsonField<Value = Json>({
  label,
  value,
  onSave,
  validate,
  hint,
}: {
  label: string;
  value: unknown;
  onSave: (value: Value) => void;
  validate?: (value: Json) => boolean;
  hint?: string;
}) {
  const { message } = useI18n();
  const [error, setError] = useState('');
  return (
    <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
      {label}
      <textarea
        aria-label={label}
        className="code-input [font-family:ui-monospace,_monospace]"
        rows={Math.min(7, Math.max(3, JSON.stringify(value, null, 2)?.split('\n').length ?? 3))}
        defaultValue={JSON.stringify(value, null, 2)}
        key={JSON.stringify(value)}
        onBlur={(event) => {
          try {
            const parsed: Json = JSON.parse(event.target.value);
            if (validate && !validate(parsed)) throw new Error('Check the expected format below.');
            setError('');
            if (JSON.stringify(parsed) !== JSON.stringify(value)) onSave(parsed as Value);
          } catch (e) {
            setError(
              e instanceof SyntaxError
                ? 'Enter valid JSON.'
                : e instanceof Error
                  ? e.message
                  : 'Enter valid JSON.',
            );
          }
        }}
      />
      {hint ? <small>{hint}</small> : null}
      {error ? (
        <span
          className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
          role="alert"
        >
          {message(error)}
        </span>
      ) : null}
    </label>
  );
}

export function BindingEditor({
  name,
  port,
  graph,
  imports,
  nodeId,
  onChange,
}: {
  name: string;
  port: Port;
  graph: Graph;
  imports?: Map<string, Graph>;
  nodeId?: string;
  onChange: (binding: Binding) => void;
}) {
  const { t, message } = useI18n();
  const binding = port.bind ?? {};
  const current =
    binding.from ?? (binding.expr ? '$expression' : binding.coalesce ? '$advanced' : '$value');
  const options = sources(graph, imports);
  const custom = binding.from && !options.some((option) => option.value === binding.from);
  return (
    <div className="binding-editor block w-full min-w-0">
      <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
        {t('editor.sourceForName', { name })}
        <select
          aria-label={t('editor.sourceForName', { name })}
          value={current}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '$value') onChange({ value: seedValue(port) });
            else if (value === '$expression')
              onChange({ expr: binding.expr ?? JSON.stringify(seedValue(port)) });
            else if (value !== '$advanced') onChange({ from: value });
          }}
        >
          {!port.artifact ? (
            <>
              <option value="$value">{t('editor.useAValueNoConnection')}</option>
              <option value="$expression">{t('editor.calculateWithCel')}</option>
            </>
          ) : null}
          {binding.coalesce ? (
            <option value="$advanced">{t('editor.fallbackSourcesCoalesce')}</option>
          ) : null}
          {custom ? <option value={binding.from}>{binding.from}</option> : null}
          {options.map((option) => {
            const error =
              option.node && nodeId
                ? connectionError(
                    graph,
                    {
                      source: option.node,
                      sourcePort: option.name,
                      target: nodeId,
                      targetPort: name,
                    },
                    imports,
                  )
                : !compatible(option.port, port)
                  ? 'Different data type'
                  : undefined;
            return (
              <option
                key={option.value}
                value={option.value}
                disabled={!!error}
                title={error ? message(error) : undefined}
              >
                {option.node ? option.label : t('editor.workflowInputName', { name: option.name })}
                {error ? ` (${t('editor.incompatible')})` : ''}
              </option>
            );
          })}
        </select>
      </label>
      {binding.from ? (
        <div className="binding-status flex items-start gap-1.5 text-muted text-[9px] mt-[-4px] mb-3.5 mx-0">
          <Link2 size={12} />
          <span>
            {t(
              binding.from.startsWith('inputs.')
                ? 'editor.workflowInput'
                : 'editor.connectedOutput',
            )}
            : <code>{binding.from}</code>
          </span>
        </div>
      ) : (
        <div className="binding-status flex items-start gap-1.5 text-muted text-[9px] mt-[-4px] mb-3.5 mx-0">
          <Unplug size={12} />
          <span>
            {t(
              binding.expr
                ? 'editor.computedInput'
                : binding.coalesce
                  ? 'editor.firstAvailableResult'
                  : 'editor.valueSuppliedDirectly',
            )}
          </span>
        </div>
      )}
      {'value' in binding ? (
        typeof binding.value === 'string' ? (
          <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
            {t('editor.valueForName', { name })}
            <textarea
              aria-label={t('editor.valueForName', { name })}
              rows={2}
              defaultValue={binding.value}
              key={String(binding.value)}
              onBlur={(event) => {
                if (event.target.value !== binding.value) onChange({ value: event.target.value });
              }}
            />
          </label>
        ) : (
          <JsonField
            label={t('editor.valueForName', { name })}
            value={binding.value}
            onSave={(value) => onChange({ value })}
            hint={t('editor.enterAJsonValueMatchingTheInputType')}
          />
        )
      ) : null}
      {binding.expr ? (
        <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
          {t('editor.expressionForName', { name })}
          <textarea
            aria-label={t('editor.expressionForName', { name })}
            className="code-input [font-family:ui-monospace,_monospace]"
            rows={2}
            defaultValue={binding.expr}
            key={binding.expr}
            onBlur={(event) => {
              if (event.target.value.trim() && event.target.value !== binding.expr)
                onChange({ expr: event.target.value });
            }}
          />
          <small>{t('editor.useInputsAndNodesInThisGraphThe')}</small>
        </label>
      ) : null}
      {binding.coalesce ? (
        <JsonField<Binding[]>
          label={t('editor.fallbackBindingsForName', { name })}
          value={binding.coalesce}
          validate={(value) => Array.isArray(value) && value.length >= 2}
          onSave={(coalesce) => onChange({ coalesce })}
          hint={t('editor.anOrderedArrayOfAtLeastTwoBindings')}
        />
      ) : null}
      {binding.from && !port.artifact ? (
        <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
          <summary>{t('editor.selectPartOfTheOutput')}</summary>
          <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
            {t('editor.jsonPointer')}
            <input
              aria-label={t('editor.jsonPointer')}
              placeholder={t('editor.fieldOrItems0')}
              defaultValue={binding.path ?? ''}
              key={binding.from + (binding.path ?? '')}
              onBlur={(event) => {
                const path = event.target.value;
                onChange({ from: binding.from, ...(path ? { path } : {}) });
              }}
            />
          </label>
        </details>
      ) : null}
    </div>
  );
}

export default function PortEditor({
  ports,
  direction,
  graph,
  imports,
  nodeId,
  onChange,
  editable = true,
  minimum = 0,
  allowFiles = false,
  schemas = [],
  canAdd = true,
}: {
  ports: Record<string, Port>;
  direction: 'inputs' | 'outputs';
  graph: Graph;
  imports?: Map<string, Graph>;
  nodeId?: string;
  onChange: (ports: Record<string, Port>) => void;
  editable?: boolean;
  minimum?: number;
  canAdd?: boolean;
  allowFiles?: boolean;
  schemas?: string[];
}) {
  const { t, message } = useI18n();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('string');
  const [error, setError] = useState('');
  function update(name: string, change: Partial<Port>) {
    onChange({ ...ports, [name]: { ...ports[name], ...change } });
  }
  function dataType(port: Port, type: string): Port {
    const { schema, schemaRef, artifact, mount, collect, ...rest } = port;
    if (type === 'file')
      return {
        ...rest,
        artifact: { mediaTypes: ['text/plain'] },
        ...(direction === 'outputs'
          ? { collect: { path: 'output.txt', mediaType: 'text/plain' } }
          : {}),
      };
    if (type === 'reference') return { ...rest, schemaRef: schemas[0] };
    return {
      ...rest,
      schema: type === 'JSON' ? true : { type, ...(type === 'array' ? { items: true } : {}) },
    };
  }
  function add() {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || ports[name]) {
      setError('Use a unique name, starting with a lowercase letter.');
      return;
    }
    const port = dataType({}, type);
    if (direction === 'inputs') {
      if (port.artifact) {
        const source = sources(graph, imports).find(
          (source) => source.node !== nodeId && compatible(source.port, port),
        );
        if (!source) {
          setError('Add a matching file output or workflow input first.');
          return;
        }
        port.bind = { from: source.value };
      } else port.bind = { value: seedValue(port) };
    }
    onChange({ ...ports, [name]: port });
    setAdding(false);
    setName('');
    setError('');
  }
  return (
    <section className="port-editor mb-6.5">
      <div className="port-section-title flex items-center justify-between gap-2.5 mb-2.5">
        <h3>{t(direction === 'inputs' ? 'execution.inputs' : 'execution.outputs')}</h3>
        {editable && canAdd ? (
          <button type="button" className="text-button" onClick={() => setAdding(!adding)}>
            <Plus size={13} />
            {t(direction === 'inputs' ? 'editor.addInput' : 'editor.addOutput')}
          </button>
        ) : null}
      </div>
      <p className="setup-hint text-[11px] leading-[1.6] text-muted mt-0 mb-3.5 mx-0">
        {t(
          direction === 'inputs'
            ? 'editor.chooseWhatThisBlockReceivesAndWhereIt'
            : 'editor.nameTheResultsThatOtherBlocksCanUse',
        )}
      </p>
      {Object.entries(ports).map(([name, port]) => (
        <div
          className="port-editor-card mt-0 mb-3.5 border border-solid border-line rounded-[10px] bg-base p-3.25 mx-0"
          key={name}
        >
          <div className="inline-row spread flex items-center gap-2.5 justify-between">
            <strong>{name}</strong>
            <span className="inline-row flex items-center gap-2.5">
              <span className="type-label inline-flex text-[10px] text-secondary bg-[rgb(var(--overlay-rgb)_/_0.016)] border border-solid border-line-strong rounded-[30px] px-2 py-1.25">
                {editorPortTypeLabel(port, t)}
              </span>
              {editable ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t(
                    direction === 'inputs' ? 'editor.removeInputName' : 'editor.removeOutputName',
                    { name },
                  )}
                  disabled={Object.keys(ports).length <= minimum}
                  title={
                    Object.keys(ports).length <= minimum
                      ? t('editor.thisBlockRequiresAtLeastOneOutput')
                      : t('editor.removePort')
                  }
                  onClick={() => {
                    const next = { ...ports };
                    delete next[name];
                    onChange(next);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              ) : null}
            </span>
          </div>
          {editable ? (
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('editor.typeOfName', { name })}
              <select
                value={portDataType(port)}
                onChange={(event) => {
                  const next = dataType(port, event.target.value);
                  if (direction === 'inputs') {
                    if (next.artifact && !port.artifact) {
                      setError('Add a file input using Add input so its source can be selected.');
                      return;
                    }
                    if (!next.artifact && port.artifact) next.bind = { value: seedValue(next) };
                  }
                  onChange({ ...ports, [name]: next });
                }}
              >
                <option value="JSON">{t('editor.anyJson')}</option>
                {portDataType(port) === '$custom' ? (
                  <option value="$custom">
                    {t('editor.customSchema')} · {editorPortTypeLabel(port, t)}
                  </option>
                ) : null}
                {['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].map(
                  (type) => (
                    <option key={type} value={type}>
                      {editorDataTypeLabel(type, t)}
                    </option>
                  ),
                )}
                {allowFiles ? <option value="file">{t('editor.file')}</option> : null}
                {schemas.length || port.schemaRef ? (
                  <option value="reference">{t('editor.schemaAlias')}</option>
                ) : null}
              </select>
            </label>
          ) : null}
          {port.schemaRef && editable ? (
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('editor.schemaAlias')}
              <select
                value={port.schemaRef}
                disabled={!schemas.length}
                onChange={(event) => update(name, { schemaRef: event.target.value })}
              >
                {!schemas.includes(port.schemaRef) ? (
                  <option value={port.schemaRef}>
                    {port.schemaRef} ({t('editor.notDeclared')})
                  </option>
                ) : null}
                {schemas.map((schema) => (
                  <option key={schema}>{schema}</option>
                ))}
              </select>
            </label>
          ) : null}
          {direction === 'inputs' ? (
            <BindingEditor
              name={name}
              port={port}
              graph={graph}
              imports={imports}
              nodeId={nodeId}
              onChange={(bind) => update(name, { bind })}
            />
          ) : null}
          {port.artifact && editable ? (
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('editor.mediaType')}
              <input
                aria-label={t('editor.mediaType')}
                defaultValue={port.artifact.mediaTypes.join(', ')}
                key={port.artifact.mediaTypes.join()}
                placeholder="text/plain"
                onBlur={(event) => {
                  const mediaTypes = event.target.value
                    .split(',')
                    .map((type) => type.trim())
                    .filter(Boolean);
                  if (mediaTypes.length && port.artifact)
                    update(name, {
                      artifact: { ...port.artifact, mediaTypes },
                      ...(port.collect
                        ? { collect: { ...port.collect, mediaType: mediaTypes[0] } }
                        : {}),
                    });
                }}
              />
            </label>
          ) : null}
          {port.collect && editable ? (
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('editor.collectFileFrom')}
              <input
                aria-label={t('editor.collectFileFrom')}
                defaultValue={port.collect.path}
                key={port.collect.path}
                onBlur={(event) => {
                  if (event.target.value.trim() && port.collect)
                    update(name, { collect: { ...port.collect, path: event.target.value } });
                }}
              />
            </label>
          ) : null}
          {port.artifact && direction === 'inputs' ? (
            <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
              {t('editor.mountPathOptional')}
              <input
                aria-label={t('editor.mountPathOptional')}
                defaultValue={port.mount ?? ''}
                key={port.mount ?? ''}
                onBlur={(event) => {
                  const next = { ...port };
                  if (event.target.value) next.mount = event.target.value;
                  else delete next.mount;
                  onChange({ ...ports, [name]: next });
                }}
              />
            </label>
          ) : null}
          <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
            <summary>{t('editor.schemaDetails')}</summary>
            {editable && !port.artifact && !port.schemaRef ? (
              <JsonField<DataSchema>
                label={t('editor.schemaForName', { name })}
                value={port.schema ?? { schemaRef: port.schemaRef }}
                validate={(value) =>
                  typeof value === 'boolean' ||
                  (!!value && typeof value === 'object' && !Array.isArray(value))
                }
                onSave={(schema) => {
                  const next = { ...port, schema };
                  delete next.schemaRef;
                  onChange({ ...ports, [name]: next });
                }}
                hint={t('editor.jsonSchemaOrTrueToAcceptAnyJson')}
              />
            ) : (
              <pre>
                {JSON.stringify(
                  port.schema ?? port.artifact ?? { schemaRef: port.schemaRef },
                  null,
                  2,
                )}
              </pre>
            )}
          </details>
        </div>
      ))}
      {!Object.keys(ports).length ? (
        <p className="setup-hint text-[11px] leading-[1.6] text-muted mt-0 mb-3.5 mx-0">
          {t(direction === 'inputs' ? 'editor.noInputsYet' : 'editor.noOutputsYet')}
        </p>
      ) : null}
      {adding ? (
        <div className="port-add-form border border-dashed border-line-strong rounded-[10px] p-3.25 mx-0 my-3.5">
          <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
            {t('editor.portName')}
            <input
              aria-label={t(
                direction === 'inputs' ? 'editor.newInputName' : 'editor.newOutputName',
              )}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('editor.eGSummary')}
            />
          </label>
          <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
            {t('editor.dataType')}
            <select value={type} onChange={(event) => setType(event.target.value)}>
              {['string', 'object', 'array', 'integer', 'number', 'boolean', 'JSON'].map((type) => (
                <option key={type} value={type}>
                  {editorDataTypeLabel(type, t)}
                </option>
              ))}
              {allowFiles ? <option value="file">{t('editor.file')}</option> : null}
            </select>
          </label>
          <button
            type="button"
            className="button small-button text-[11px] min-h-8 px-3 py-1.75"
            onClick={add}
          >
            {t('editor.createPort')}
          </button>
        </div>
      ) : null}
      {error ? (
        <p
          className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
          role="alert"
        >
          {message(error)}
        </p>
      ) : null}
    </section>
  );
}
