import { ArrowRight, Braces, Copy, Plus, Settings2, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { NodeIcon, nodeMeta } from '../../components/ui';
import type { Resource } from '../../lib/engine/types';
import { nodePorts } from '../../lib/graph';
import { humanResponseFields, parseHumanResponse } from '../../lib/humanResponse';
import { useI18n } from '../../lib/i18n';
import { effectiveAgentTools, mcpToolResponse } from '../../lib/nodeMcp';
import { agentSandboxPermission } from '../../lib/nodeSandbox';
import type { SavedConnection, SavedMcpConnection } from '../../lib/setup';
import {
  type Binding,
  type DataSchema,
  type Graph,
  type NodeDefinition,
  type Pipeline,
  record,
} from '../../lib/types';
import { validBinding } from '../../lib/validation';
import { HumanResponseForm } from '../engine/HumanResponseForm';
import { AgentMcp, NodeMcp } from './NodeMcp';
import PortEditor, { JsonField } from './PortEditor';

function TextField({
  label,
  value,
  onSave,
  hint,
  multiline = false,
  optional = false,
}: {
  label: string;
  value: string;
  onSave: (value: string) => void;
  hint?: string;
  multiline?: boolean;
  optional?: boolean;
}) {
  const { message, t } = useI18n();
  const inputId = useId();
  const hintId = `${inputId}-help`;
  const [error, setError] = useState('');
  const props = {
    id: inputId,
    'aria-label': label,
    'aria-describedby': hint ? hintId : undefined,
    'aria-required': !optional,
    defaultValue: value,
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!optional && !event.target.value.trim()) {
        setError('This field cannot be empty.');
        return;
      }
      setError('');
      if (event.target.value !== value) onSave(event.target.value);
    },
  };

  return (
    <label
      className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6"
      htmlFor={inputId}
    >
      <span>
        {label}
        {optional ? <span className="ml-1 text-muted">{t('editor.optional')}</span> : null}
      </span>
      {multiline ? <textarea key={value} rows={5} {...props} /> : <input key={value} {...props} />}
      {hint ? <small id={hintId}>{hint}</small> : null}
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

function NumberField({
  label,
  value,
  max,
  onSave,
  hint,
}: {
  label: string;
  value: number;
  max: number;
  onSave: (value: number) => void;
  hint: string;
}) {
  const { message } = useI18n();
  const [error, setError] = useState('');

  return (
    <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
      {label}
      <input
        key={String(value)}
        type="number"
        aria-label={label}
        min={1}
        max={max}
        step={1}
        defaultValue={value}
        onBlur={(event) => {
          const n = Number(event.target.value);
          if (!Number.isInteger(n) || n < 1 || n > max) {
            setError('Enter a whole number from 1 to {max}.');
            return;
          }
          setError('');
          if (n !== value) onSave(n);
        }}
      />
      <small>{hint}</small>
      {error ? (
        <span
          className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
          role="alert"
        >
          {message(error, { max })}
        </span>
      ) : null}
    </label>
  );
}

function PromptField({
  label,
  hint,
  value,
  files,
  onSave,
  optional = false,
  sourceLabel,
}: {
  label: string;
  hint: string;
  value: Record<string, unknown>;
  files: string[];
  onSave: (value: Record<string, unknown> | undefined) => void;
  optional?: boolean;
  sourceLabel: string;
}) {
  const { t } = useI18n();
  const remembered = useRef<{ text?: string; file?: string }>({});
  const [expanded, setExpanded] = useState(!!value.file);

  useEffect(() => {
    if (value.file) setExpanded(true);
  }, [value.file]);

  return (
    <>
      {!value.file ? (
        <TextField
          label={label}
          hint={hint}
          multiline
          optional={optional}
          value={String(value.text ?? '')}
          onSave={(text) => onSave(optional && !text.trim() ? undefined : { text })}
        />
      ) : null}
      <details
        className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>{sourceLabel}</summary>
        <p className="my-3 text-[11px] leading-relaxed text-muted">{t('editor.promptFileHelp')}</p>
        <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
          {sourceLabel}
          <select
            aria-label={sourceLabel}
            value={value.file ? 'file' : 'text'}
            onChange={(event) => {
              if (value.file) remembered.current.file = String(value.file);
              else remembered.current.text = String(value.text ?? '');
              if (event.target.value === 'file') {
                const file = files.find((file) => file === remembered.current.file) ?? files[0];
                if (file) onSave({ file });
              } else {
                const text = remembered.current.text ?? (optional ? '' : t('editor.taskStarter'));
                onSave(optional && !text ? undefined : { text });
              }
            }}
          >
            <option value="text">{t('editor.writeInstructionsHere')}</option>
            <option value="file" disabled={!files.length}>
              {t('editor.packageFile')}
            </option>
          </select>
        </label>
        {value.file ? (
          <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
            {t('editor.promptFile')}
            <select
              aria-label={t('editor.promptFile')}
              value={String(value.file)}
              onChange={(event) => onSave({ file: event.target.value })}
            >
              {!files.includes(String(value.file)) ? (
                <option value={String(value.file)}>
                  {String(value.file)} · {t('editor.notAvailable')}
                </option>
              ) : null}
              {files.map((file) => (
                <option key={file}>{file}</option>
              ))}
            </select>
          </label>
        ) : null}
      </details>
    </>
  );
}

function ToolArgumentValues({
  value,
  schema,
  onSave,
}: {
  value: unknown;
  schema: unknown;
  onSave: (value: Binding) => void;
}) {
  const { t } = useI18n();
  const serialized = JSON.stringify(value ?? {}, null, 2);
  const [draft, setDraft] = useState(serialized);

  useEffect(() => setDraft(serialized), [serialized]);
  const properties = Object.fromEntries(
    Object.entries(record(record(schema).properties)).map(([name, property]) => [
      name,
      { ...record(property), title: record(property).title || name.replace(/[_-]+/g, ' ') },
    ]),
  );

  return (
    <div className="mb-6">
      <HumanResponseForm
        schema={{ ...record(schema), properties }}
        value={draft}
        disabled={false}
        jsonLabel={t('editor.argumentsJson')}
        draftHelp={t('editor.toolArgumentsHelp')}
        onChange={(value) => {
          setDraft(value);
          const parsed = parseHumanResponse(value);
          if (parsed) onSave({ value: parsed as Binding['value'] });
        }}
      />
    </div>
  );
}

function ToolArgumentsField({
  value,
  onSave,
  schema,
}: {
  value: unknown;
  onSave: (value: Binding) => void;
  schema?: unknown;
}) {
  const { t } = useI18n();
  const binding = record(value);
  const mode =
    'expr' in binding
      ? 'expr'
      : 'from' in binding || 'coalesce' in binding || 'path' in binding
        ? 'binding'
        : 'value';
  const remembered = useRef<Record<string, Binding>>({});
  const argumentSchema = record(schema);
  const fixedArguments = record(binding.value);
  const unsupported =
    mode === 'value' &&
    argumentSchema.type === 'object' &&
    argumentSchema.additionalProperties === false &&
    !['$ref', 'allOf', 'anyOf', 'oneOf', 'patternProperties'].some((key) => key in argumentSchema)
      ? Object.keys(fixedArguments).filter(
          (name) => !Object.hasOwn(record(argumentSchema.properties), name),
        )
      : [];

  return (
    <>
      <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
        {t('editor.toolArguments')}
        <select
          aria-label={t('editor.toolArguments')}
          value={mode}
          onChange={(event) => {
            remembered.current[mode] = binding as Binding;
            const next = event.target.value;
            onSave(
              remembered.current[next] ?? (next === 'expr' ? { expr: 'args' } : { value: {} }),
            );
          }}
        >
          <option value="value">{t('editor.fixedToolValues')}</option>
          <option value="expr">{t('editor.useBlockInputsCel')}</option>
          {mode === 'binding' || remembered.current.binding ? (
            <option value="binding">{t('editor.advancedDataMapping')}</option>
          ) : null}
        </select>
        <small>{t('editor.toolArgumentsHelp')}</small>
      </label>
      {unsupported.length ? (
        <div className="mb-5 text-[11px] leading-relaxed text-secondary">
          <p role="status" className="mb-2">
            {t('editor.unsupportedToolArguments', { names: unsupported.join(', ') })}
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              onSave({
                value: Object.fromEntries(
                  Object.entries(fixedArguments).filter(([name]) => !unsupported.includes(name)),
                ) as Binding['value'],
              })
            }
          >
            {t('editor.removeUnsupportedToolArguments')}
          </button>
        </div>
      ) : null}
      {mode === 'expr' ? (
        <TextField
          label={t('editor.argumentsExpression')}
          value={String(binding.expr)}
          onSave={(expr) => onSave({ expr })}
          hint={t('editor.argsContainsThisBlockSInputsReturnAn')}
        />
      ) : mode === 'binding' ? (
        <JsonField<Binding>
          label={t('editor.toolArgumentBinding')}
          value={value}
          onSave={onSave}
          validate={validBinding}
          hint={t('editor.toolBindingHelp')}
        />
      ) : humanResponseFields(schema) ? (
        <ToolArgumentValues schema={schema} value={binding.value} onSave={onSave} />
      ) : record(schema).type === 'object' &&
        record(schema).additionalProperties === false &&
        !Object.keys(record(record(schema).properties)).length ? (
        <>
          <p className="mb-4 text-[11px] leading-relaxed text-muted">
            {t('editor.toolNoArguments')}
          </p>
          <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
            <summary>{t('editor.argumentsJson')}</summary>
            <JsonField
              label={t('editor.argumentsJson')}
              value={binding.value ?? {}}
              onSave={(value) => onSave({ value })}
              validate={(value) => !!value && typeof value === 'object' && !Array.isArray(value)}
              hint={t('editor.aJsonObjectWithTheToolSArgument')}
            />
          </details>
        </>
      ) : (
        <JsonField
          label={t('editor.argumentsJson')}
          value={binding.value ?? {}}
          onSave={(value) => onSave({ value })}
          validate={(value) => !!value && typeof value === 'object' && !Array.isArray(value)}
          hint={t('editor.aJsonObjectWithTheToolSArgument')}
        />
      )}
    </>
  );
}

export default function Inspector({
  id,
  node,
  graph,
  resources,
  files,
  promptFiles,
  onEdit,
  onSource,
  onDuplicate,
  onRemove,
  onBody,
  importedGraphs,
  onWorkflow,
  showPorts,
  modelConnections = [],
  mcpConnections = [],
  engineResources = [],
  engineConnected = false,
  onModelChange,
  onConnectModels,
  onConnectMcp,
  onConnectSandboxes,
  onSandboxChange,
  onMcpChange,
  onMcpResponse,
}: {
  id?: string;
  node?: NodeDefinition;
  graph: Graph;
  resources: Pipeline['spec'];
  files: string[];
  promptFiles: string[];
  importedGraphs?: Map<string, Graph>;
  onEdit: (key: string, value: unknown) => void;
  onSource: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onBody: () => void;
  onWorkflow?: () => void;
  showPorts?: boolean;
  onNotify?: (message: string) => void;
  modelConnections?: SavedConnection[];
  mcpConnections?: SavedMcpConnection[];
  engineResources?: Resource[];
  engineConnected?: boolean;
  onModelChange: (
    connection: string,
    model: string,
    parameters?: Record<string, unknown> | null,
  ) => void;
  onConnectModels?: () => void;
  onConnectMcp?: () => void;
  onConnectSandboxes?: () => void;
  onSandboxChange: (profile: string) => void;
  onMcpChange: (connection: string, tool: string, enabled?: boolean) => void;
  onMcpResponse: (response: 'structured' | 'content', schema: DataSchema) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'setup' | 'ports'>('setup');

  useEffect(() => {
    if (showPorts) setTab('ports');
  }, [showPorts]);
  if (!node || !id) return null;
  const meta = nodeMeta[node.type];
  const config = record(node[node.type]);
  const mcpCatalog = [
    ...mcpConnections,
    ...engineResources
      .filter(
        (resource) =>
          resource.kind === 'mcp' &&
          resource.status === 'available' &&
          !mcpConnections.some((connection) => connection.id === resource.id),
      )
      .map((resource) => ({
        id: resource.id,
        title: resource.title,
        allowedTools: resource.capabilities,
        tools: resource.capabilities.map((name) => ({ name, inputSchema: {} })),
      })),
  ];
  const selectedMcpTool = mcpCatalog
    .find((connection) => connection.id === resources.mcp?.[String(config.server)]?.connection)
    ?.tools.find((tool) => tool.name === config.name);
  const mcpResponse = mcpToolResponse(selectedMcpTool);
  const responseMatches =
    !node.outputs?.result?.schemaRef &&
    (config.response ?? 'structured') === mcpResponse.response &&
    JSON.stringify(node.outputs?.result?.schema) === JSON.stringify(mcpResponse.schema);
  const cases = config.cases as { name: string; when: string }[];
  const outputs = nodePorts(node, importedGraphs);
  const editConfig = (key: string, value: unknown) => {
    const next = { ...config };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onEdit(node.type, next);
  };
  const aliases = (kind: 'models' | 'mcp' | 'sandboxes') => Object.keys(resources[kind] ?? {});
  const resourceSelect = (
    label: string,
    kind: 'models' | 'mcp' | 'sandboxes',
    value: string,
    onSave: (value: string) => void,
  ) => (
    <div className="resource-field mb-4.5">
      <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
        {label}
        <select aria-label={label} value={value} onChange={(event) => onSave(event.target.value)}>
          {!aliases(kind).includes(value) ? (
            <option value={value}>{value || t('editor.chooseAnAlias')}</option>
          ) : null}
          {aliases(kind).map((alias) => (
            <option key={alias}>{alias}</option>
          ))}
        </select>
        <small>
          {t(
            kind === 'sandboxes'
              ? 'editor.sandboxHelp'
              : kind === 'mcp'
                ? 'editor.mcpServerHelp'
                : 'editor.modelAliasHelp',
          )}
        </small>
      </label>
      <button className="text-button" type="button" onClick={onWorkflow}>
        {t(
          kind === 'models'
            ? 'editor.manageModels'
            : kind === 'mcp'
              ? 'editor.manageMcpServers'
              : 'editor.manageSandboxes',
        )}
        <ArrowRight size={12} />
      </button>
    </div>
  );

  return (
    <aside className="inspector setup-inspector w-85 [&_.field_small]:text-[11px]! [&_.field_small]:leading-relaxed! shrink-0 overflow-hidden border-l border-solid border-l-line bg-surface flex flex-col">
      <header className="inspector-header flex items-center justify-between pt-4 pb-2 px-4.5">
        <span className="text-[12px] text-secondary font-medium">{t('editor.blockSettings')}</span>
        <div className="inline-row flex items-center gap-2.5">
          <button
            type="button"
            className="icon-button"
            onClick={onDuplicate}
            aria-label={t('editor.duplicateNode')}
          >
            <Copy size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onRemove}
            disabled={Object.keys(graph.nodes).length <= 1}
            title={
              Object.keys(graph.nodes).length <= 1
                ? t('editor.keepAtLeastOneBlockInTheWorkflow')
                : t('editor.deleteBlock')
            }
            aria-label={t('editor.deleteNode')}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>
      <div className="inspector-title pt-4.5 pb-5.75 px-5.25">
        <span className={`node-icon tint-${meta.color}`}>
          <NodeIcon kind={node.type} size={20} />
        </span>
        <div>
          <h2>{id.replace(/_/g, ' ')}</h2>
          <p>{t(meta.detail)}</p>
        </div>
      </div>
      <div className="inspector-tabs flex border-t border-solid border-t-[var(--line)] border-b border-solid border-b-[var(--line)]">
        <button
          type="button"
          className={tab === 'setup' ? 'active' : ''}
          onClick={() => setTab('setup')}
        >
          <Settings2 size={13} />
          {t('editor.setup')}
        </button>
        <button
          type="button"
          className={tab === 'ports' ? 'active' : ''}
          onClick={() => setTab('ports')}
        >
          {t('editor.inputsOutputs')}
        </button>
      </div>
      <div className="inspector-content overflow-auto min-h-0 flex-1 px-5.25 py-6">
        <div hidden={tab !== 'setup'}>
          <p className="mb-5 text-[12px] leading-relaxed text-secondary">
            {t(`editor.blockPurpose.${node.type}`)}
          </p>
          {['llm', 'agent', 'human'].includes(node.type) ? (
            <PromptField
              label={t(node.type === 'human' ? 'execution.reviewRequest' : 'editor.instructions')}
              hint={t(node.type === 'human' ? 'editor.humanRequestHelp' : 'editor.taskHelp')}
              value={record(config.prompt)}
              files={promptFiles}
              sourceLabel={t('editor.promptSource')}
              onSave={(value) => editConfig('prompt', value)}
            />
          ) : null}
          {['llm', 'agent'].includes(node.type) ? (
            <>
              <NodeModel
                key={String(resources.models?.[String(config.model)]?.connection ?? '')}
                resource={resources.models?.[String(config.model)] ?? {}}
                connections={modelConnections}
                engineResources={engineResources}
                onChange={onModelChange}
                onConnect={onConnectModels}
              />
              <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
                <summary>{t('editor.modelAlias')}</summary>
                {resourceSelect(
                  t('editor.modelAlias'),
                  'models',
                  String(config.model ?? ''),
                  (value) => editConfig('model', value),
                )}
              </details>
            </>
          ) : null}
          {['llm', 'agent'].includes(node.type) ? (
            <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
              <summary>{t('editor.systemInstructions')}</summary>
              <PromptField
                label={t('editor.systemInstructions')}
                hint={t('editor.systemInstructionsHelp')}
                optional
                value={record(config.instructions)}
                files={promptFiles}
                sourceLabel={t('editor.systemInstructionsSource')}
                onSave={(value) => editConfig('instructions', value)}
              />
            </details>
          ) : null}
          {['agent', 'code'].includes(node.type) ? (
            <NodeSandbox
              resources={resources}
              node={node}
              engineResources={engineResources}
              engineConnected={engineConnected}
              onChange={onSandboxChange}
              onToolsChange={(tools) => onEdit('tools', tools)}
              onConnect={onConnectSandboxes}
            />
          ) : null}
          {node.type === 'agent' ? (
            <>
              <AgentMcp
                resources={resources}
                node={node}
                connections={mcpCatalog}
                onChange={onMcpChange}
                onToolsChange={(tools) => onEdit('tools', tools)}
                onConnect={onConnectMcp}
              />
              <NumberField
                label={t('editor.maximumModelSteps')}
                value={Number(config.maxSteps)}
                max={10000}
                onSave={(value) => editConfig('maxSteps', value)}
                hint={t('editor.limitsHowManyModelCallsThisAgentCan')}
              />
              <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
                <summary>{t('editor.toolPermissions')}</summary>
                <JsonField
                  label={t('editor.allowedTools')}
                  value={node.tools ?? { inherit: true }}
                  validate={(value) =>
                    !!value && typeof value === 'object' && !Array.isArray(value)
                  }
                  onSave={(value) => onEdit('tools', value)}
                  hint={t('editor.inheritMcpAliasesWithToolListsAndSandbox')}
                />
              </details>
            </>
          ) : null}
          {node.type === 'code' ? (
            <div className="command-editor">
              <TextField
                label={t('editor.executable')}
                value={String((config.command as string[])[0])}
                onSave={(value) =>
                  editConfig('command', [value, ...(config.command as string[]).slice(1)])
                }
                hint={t('editor.theEngineRunsThisExecutableInTheSelected')}
              />
              <h3>{t('editor.arguments')}</h3>
              <p className="mb-4 text-[11px] leading-relaxed text-muted">
                {t('editor.commandArgumentsHelp')}
              </p>
              {(config.command as string[]).slice(1).map((argument, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Command arguments are editable positional slots without IDs.
                <div className="command-argument flex items-start gap-1.5" key={index}>
                  <TextField
                    label={t('editor.argumentCount', { count: index + 1 })}
                    value={argument}
                    optional
                    multiline={argument.includes('\n') || argument.length > 80}
                    onSave={(value) =>
                      editConfig(
                        'command',
                        (config.command as string[]).map((arg, i) =>
                          i === index + 1 ? value : arg,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('editor.removeArgumentCount', { count: index + 1 })}
                    onClick={() =>
                      editConfig(
                        'command',
                        (config.command as string[]).filter((_, i) => i !== index + 1),
                      )
                    }
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-button"
                onClick={() => editConfig('command', [...(config.command as string[]), ''])}
              >
                <Plus size={13} />
                {t('editor.addArgument')}
              </button>
            </div>
          ) : null}
          {node.type === 'tool' ? (
            <>
              <NodeMcp
                resource={resources.mcp?.[String(config.server)] ?? {}}
                name={String(config.name ?? '')}
                connections={mcpCatalog}
                onChange={onMcpChange}
                onConnect={onConnectMcp}
              />
              {selectedMcpTool && !responseMatches ? (
                <div className="mb-5 text-[11px] leading-relaxed text-secondary">
                  <p className="mb-2">
                    {t(
                      mcpResponse.response === 'content'
                        ? 'editor.mcpContentResponseHelp'
                        : 'editor.mcpStructuredResponseHelp',
                    )}
                  </p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onMcpResponse(mcpResponse.response, mcpResponse.schema)}
                  >
                    {t('editor.useMcpResponse')}
                  </button>
                </div>
              ) : null}
              <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
                <summary>{t('editor.mcpAdvanced')}</summary>
                {resourceSelect(t('editor.mcpServerAlias'), 'mcp', String(config.server), (value) =>
                  editConfig('server', value),
                )}
                <TextField
                  label={t('editor.toolName')}
                  value={String(config.name)}
                  onSave={(value) => editConfig('name', value)}
                  hint={t('editor.exactToolNameExposedByThisMcpServer')}
                />
              </details>
              <ToolArgumentsField
                key={`${String(config.server)}:${String(config.name)}`}
                schema={
                  mcpConnections
                    .find(
                      (connection) =>
                        connection.id === resources.mcp?.[String(config.server)]?.connection,
                    )
                    ?.tools.find((tool) => tool.name === config.name)?.inputSchema
                }
                value={config.arguments}
                onSave={(value) => editConfig('arguments', value)}
              />
              <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
                <summary>{t('editor.responseFormat')}</summary>
                <p className="my-3 text-[11px] leading-relaxed text-muted">
                  {t('editor.toolResponseHelp')}
                </p>
                <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                  {t('editor.responseFormat')}
                  <select
                    aria-label={t('editor.responseFormat')}
                    value={String(config.response ?? 'structured')}
                    onChange={(event) => editConfig('response', event.target.value)}
                  >
                    <option value="structured">{t('editor.structuredData')}</option>
                    <option value="content">{t('editor.contentBlocks')}</option>
                  </select>
                </label>
              </details>
            </>
          ) : null}
          {node.type === 'switch' ? (
            <>
              <p className="setup-hint text-[11px] leading-[1.6] text-muted mt-0 mb-3.5 mx-0">
                {t('editor.firstMatchingConditionWinsLaterBlocksCanRead')}
              </p>
              {cases.map((item, index) => (
                <div
                  className="setup-group border-t border-solid border-line pt-4 mx-0 my-3.5"
                  // biome-ignore lint/suspicious/noArrayIndexKey: Routes have editable names and positional identity, without separate IDs.
                  key={index}
                >
                  <TextField
                    label={t('editor.routeCountName', { count: index + 1 })}
                    value={item.name}
                    onSave={(name) =>
                      editConfig(
                        'cases',
                        cases.map((item, i) => (i === index ? { ...item, name } : item)),
                      )
                    }
                  />
                  <TextField
                    label={t('editor.routeCountCondition', { count: index + 1 })}
                    value={item.when}
                    onSave={(when) =>
                      editConfig(
                        'cases',
                        cases.map((item, i) => (i === index ? { ...item, when } : item)),
                      )
                    }
                    hint={t('editor.aCelBooleanUsingArgsEGArgs')}
                  />
                  <button
                    type="button"
                    className="text-button"
                    disabled={cases.length <= 1}
                    onClick={() =>
                      editConfig(
                        'cases',
                        cases.filter((_, i) => i !== index),
                      )
                    }
                  >
                    {t('editor.removeRoute')}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  let i = cases.length + 1;
                  while (
                    cases.some((item) => item.name === `route_${i}`) ||
                    config.default === `route_${i}`
                  )
                    i++;
                  editConfig('cases', [...cases, { name: `route_${i}`, when: 'false' }]);
                }}
              >
                <Plus size={13} />
                {t('editor.addRoute')}
              </button>
              <TextField
                label={t('editor.defaultRoute')}
                value={String(config.default)}
                onSave={(value) => editConfig('default', value)}
              />
            </>
          ) : null}
          {node.type === 'foreach' ? (
            <>
              <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                {t('editor.collectionInput')}
                <select
                  value={String(config.over)}
                  onChange={(event) => editConfig('over', event.target.value)}
                >
                  {Object.entries(node.inputs ?? {})
                    .filter(
                      ([, port]) =>
                        record(port.schema).type === 'array' || port.artifact?.collection,
                    )
                    .map(([name]) => (
                      <option key={name}>{name}</option>
                    ))}
                </select>
              </label>
              <NumberField
                label={t('editor.concurrentIterations')}
                value={Number(config.concurrency)}
                max={2147483647}
                onSave={(value) => editConfig('concurrency', value)}
                hint={t('editor.howManyItemsMayBeProcessedAtOnce')}
              />
            </>
          ) : null}
          {node.type === 'loop' ? (
            <>
              <NumberField
                label={t('editor.maximumIterations')}
                value={Number(config.maxIterations)}
                max={100000}
                onSave={(value) => editConfig('maxIterations', value)}
                hint={t('editor.aHardLimitOnRepeatedBodyExecution')}
              />
              <TextField
                label={t('editor.stopCondition')}
                value={String(config.until)}
                onSave={(value) => editConfig('until', value)}
                hint={t('editor.aCelBooleanEvaluatedAfterTheBodyFinishes')}
              />
              <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                {t('editor.whenTheLimitIsReached')}
                <select
                  value={String(config.onLimit)}
                  onChange={(event) => editConfig('onLimit', event.target.value)}
                >
                  <option value="fail">{t('editor.failTheRun')}</option>
                  <option value="return_last">{t('editor.returnTheLastResult')}</option>
                </select>
              </label>
              <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
                <summary>{t('editor.stateCarriedBetweenIterations')}</summary>
                <JsonField
                  label={t('editor.loopState')}
                  value={config.state}
                  onSave={(value) => editConfig('state', value)}
                  validate={(value) =>
                    !!value && typeof value === 'object' && !Array.isArray(value)
                  }
                  hint={t('editor.eachStateValueDeclaresSchemaInitialBindingAnd')}
                />
              </details>
            </>
          ) : null}
          {['foreach', 'loop'].includes(node.type) ? (
            <>
              <button type="button" className="button full" onClick={onBody}>
                {t('editor.editBodyGraph')}
                <ArrowRight size={15} />
              </button>
              <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
                <summary>{t('editor.inputsPassedToTheBody')}</summary>
                <JsonField
                  label={t('editor.bodyInputBindings')}
                  value={config.with}
                  onSave={(value) => editConfig('with', value)}
                  validate={(value) =>
                    !!value && typeof value === 'object' && !Array.isArray(value)
                  }
                  hint={
                    node.type === 'foreach'
                      ? t('editor.bindBodyInputNamesToArgsIterationItem')
                      : t('editor.bindBodyInputNamesToArgsStateOr')
                  }
                />
              </details>
            </>
          ) : null}
          {node.type === 'pipeline' ? (
            <>
              <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                {t('editor.childPipelineFile')}
                <select
                  aria-label={t('editor.childPipelineFile')}
                  value={String(config.file)}
                  onChange={(event) => editConfig('file', event.target.value)}
                >
                  {files
                    .filter((file) => /\.ya?ml$/.test(file))
                    .map((file) => (
                      <option key={file}>{file}</option>
                    ))}
                </select>
                <small>{t('editor.addTheChildPackageInFilesFirst')}</small>
              </label>
              <JsonField
                label={t('editor.childPermissions')}
                value={config.permissions}
                onSave={(value) => editConfig('permissions', value)}
                validate={(value) => !!value && typeof value === 'object' && !Array.isArray(value)}
                hint={t('editor.explicitModelMcpSandboxAndSecretPermissionsFor')}
              />
            </>
          ) : null}
          <TextField
            label={t('editor.description')}
            value={node.description ?? ''}
            optional
            hint={t('editor.descriptionHelp')}
            onSave={(value) => onEdit('description', value || undefined)}
          />
          <button
            type="button"
            className="button full setup-next mx-0 my-4"
            onClick={() => setTab('ports')}
          >
            {t('editor.connectInputsDefineOutputs')}
            <ArrowRight size={15} />
          </button>
          <details className="field-details border-t border-solid border-t-line pt-3 mx-0 my-4">
            <summary>{t('editor.runConditionsAdvancedOptions')}</summary>
            <TextField
              label={t('editor.runConditionCel')}
              value={node.when ?? ''}
              optional
              onSave={(value) => onEdit('when', value || undefined)}
              hint={t('editor.leaveBlankToRunWheneverInputsAreReady')}
            />
            <TextField
              label={t('editor.waitForBlocks')}
              value={(node.needs ?? []).join(', ')}
              optional
              onSave={(value) =>
                onEdit(
                  'needs',
                  value
                    ? value
                        .split(',')
                        .map((value) => value.trim())
                        .filter(Boolean)
                    : undefined,
                )
              }
              hint={t('editor.commaSeparatedBlockIdsThisWaitsWithoutTransferring')}
            />
            <button type="button" className="text-button" onClick={onSource}>
              <Braces size={14} />
              {t('editor.openYaml')}
            </button>
          </details>
        </div>
        {tab === 'ports' ? (
          <>
            <PortEditor
              key={`${id}inputs`}
              ports={node.inputs ?? {}}
              direction="inputs"
              graph={graph}
              imports={importedGraphs}
              nodeId={id}
              onChange={(inputs) => onEdit('inputs', inputs)}
              allowFiles={node.type !== 'llm'}
              schemas={Object.keys(resources.schemas ?? {})}
            />
            <PortEditor
              key={`${id}outputs`}
              ports={outputs}
              direction="outputs"
              graph={graph}
              imports={importedGraphs}
              onChange={(outputs) => onEdit('outputs', outputs)}
              editable={!['switch', 'foreach', 'loop', 'pipeline'].includes(node.type)}
              minimum={1}
              canAdd={node.type !== 'tool'}
              allowFiles={['agent', 'code'].includes(node.type)}
              schemas={Object.keys(resources.schemas ?? {})}
            />
            {['switch', 'foreach', 'loop', 'pipeline'].includes(node.type) ? (
              <p className="setup-hint text-[11px] leading-[1.6] text-muted mt-0 mb-3.5 mx-0">
                {t(
                  node.type === 'pipeline'
                    ? 'editor.theseOutputsComeFromTheChildPipelineExports'
                    : node.type === 'switch'
                      ? 'editor.theseOutputsComeFromTheSelectedRouteEdit'
                      : 'editor.theseOutputsComeFromTheBodyGraphExports',
                )}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}

function NodeSandbox({
  resources,
  node,
  engineResources,
  engineConnected,
  onChange,
  onToolsChange,
  onConnect,
}: {
  resources: Pipeline['spec'];
  node: NodeDefinition;
  engineResources: Resource[];
  engineConnected: boolean;
  onChange: (profile: string) => void;
  onToolsChange: (tools: Record<string, unknown>) => void;
  onConnect?: () => void;
}) {
  const { t } = useI18n();
  const profile = String(resources.sandboxes?.[node.sandbox ?? '']?.profile ?? '');
  const environments = new Map<string, Resource | undefined>();
  for (const binding of Object.values(resources.sandboxes ?? {}))
    if (typeof binding.profile === 'string') environments.set(binding.profile, undefined);
  for (const resource of engineResources)
    if (resource.kind === 'sandbox') environments.set(resource.id, resource);
  const available = (resource?: Resource) =>
    resource?.status === 'available' &&
    (node.type !== 'code' || resource.capabilities.includes('process.exec'));
  const selected = environments.get(profile);
  const permissions = [
    ['files.read', 'resources.readFiles'],
    ['files.write', 'resources.writeFiles'],
    ['process.exec', 'resources.runCommands'],
  ] as const;
  const grants = effectiveAgentTools(resources, node).sandbox as string[];
  const title = (id: string, resource?: Resource) => {
    const generatedTitle =
      !resource?.title || resource.title === id || resource.title.endsWith(` / ${id}`);
    if (!generatedTitle) return resource.title;
    if (id === 'node_box') return t('resources.nodeSandbox');
    if (id === 'python_box') return t('resources.pythonSandbox');
    return id.replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
  };

  return (
    <section data-tour="node-sandbox" className="mb-6 flex min-w-0 flex-col gap-4">
      <label className="field flex flex-col gap-2.5 text-[11px] leading-relaxed text-muted">
        {t('editor.sandboxEnvironment')}
        <select
          className="h-11 w-full"
          aria-label={t('editor.sandboxEnvironment')}
          value={profile}
          onChange={(event) => onChange(event.target.value)}
        >
          {!profile ? <option value="">{t('editor.chooseSandbox')}</option> : null}
          {[...environments].map(([id, resource]) => (
            <option key={id} value={id} disabled={engineConnected && !available(resource)}>
              {title(id, resource)}
              {engineConnected && !available(resource) ? ` · ${t('editor.notAvailable')}` : ''}
            </option>
          ))}
        </select>
        <small>{t('editor.sandboxEnvironmentHelp')}</small>
      </label>
      <p
        className={`text-[11px] leading-relaxed ${profile && engineConnected && !available(selected) ? 'text-amber' : 'text-muted'}`}
        role="status"
      >
        {t(
          !environments.size
            ? 'editor.noSandboxEnvironments'
            : profile && !engineConnected
              ? 'editor.sandboxOffline'
              : profile && !available(selected)
                ? 'editor.sandboxUnavailable'
                : 'editor.sandboxSelectedHelp',
        )}
      </p>
      {node.type === 'agent' ? (
        <fieldset className="min-w-0 border-0 p-0">
          <legend className="mb-2 text-[12px] font-medium text-ink">
            {t('editor.sandboxPermissions')}
          </legend>
          <p className="mb-2 text-[11px] leading-relaxed text-muted">
            {t('editor.sandboxPermissionsHelp')}
          </p>
          {permissions.map(([permission, label]) => {
            const allowed =
              !!profile &&
              (!engineConnected ||
                (selected?.status === 'available' && selected.capabilities.includes(permission)));
            return (
              <label
                key={permission}
                className="flex items-start gap-2.5 py-2 text-[12px] leading-relaxed text-ink"
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-accent"
                  aria-label={t(label)}
                  checked={grants.includes(permission)}
                  disabled={!allowed && !grants.includes(permission)}
                  onChange={(event) =>
                    onToolsChange(
                      agentSandboxPermission(resources, node, permission, event.target.checked),
                    )
                  }
                />
                <span>
                  {t(label)}
                  {profile && engineConnected && !allowed ? (
                    <span className="ml-1 text-[11px] text-muted">
                      · {t('editor.notAvailable')}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      ) : null}
      {onConnect ? (
        <button className="text-button self-start" type="button" onClick={onConnect}>
          {t('editor.manageSandboxes')}
          <ArrowRight size={12} />
        </button>
      ) : null}
    </section>
  );
}

function NodeModel({
  resource,
  connections,
  engineResources,
  onChange,
  onConnect,
}: {
  resource: Record<string, unknown>;
  connections: SavedConnection[];
  engineResources: Resource[];
  onChange: (
    connection: string,
    model: string,
    parameters?: Record<string, unknown> | null,
  ) => void;
  onConnect?: () => void;
}) {
  const { t } = useI18n();
  const connection = String(resource.connection ?? '');
  const value = String(resource.model ?? '');
  const selected = connections.find((item) => item.id === connection);
  const models = selected?.models ?? [];
  const available = new Map(connections.map((item) => [item.id, item.title]));
  for (const item of engineResources)
    if (item.kind === 'model' && item.status === 'available' && !available.has(item.id))
      available.set(item.id, item.title);
  const unavailableModel = !!value && !models.some((item) => item.id === value);

  return (
    <section data-tour="node-model" className="mb-6 flex flex-col gap-4">
      <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5]">
        {t('editor.modelSource')}
        <select
          className="h-11 w-full"
          aria-label={t('editor.modelSource')}
          value={connection}
          onChange={(event) => onChange(event.target.value, '')}
        >
          {!available.has(connection) ? (
            <option value={connection}>{t('editor.chooseModelSource')}</option>
          ) : null}
          {[...available].map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
      </label>
      <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5]">
        {t('modelSetup.model')}
        <select
          className="h-11 w-full"
          aria-label={t('modelSetup.model')}
          value={value}
          disabled={!available.has(connection)}
          onChange={(event) => onChange(connection, event.target.value)}
        >
          <option value="">
            {available.has(connection) ? t('editor.useProviderDefault') : t('editor.chooseModel')}
            {selected?.defaultModel ? ` · ${selected.defaultModel}` : ''}
          </option>
          {unavailableModel ? (
            <option value={value} disabled>
              {t('editor.savedModelUnavailable', { model: value })}
            </option>
          ) : null}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[11px] leading-relaxed text-muted">
        {t(
          !available.has(connection)
            ? 'editor.modelsNeedSource'
            : selected && !models.length
              ? 'editor.modelsCatalogUnavailable'
              : 'editor.nodeModelHint',
        )}
      </p>
      {Object.keys(record(resource.parameters)).length &&
      (selected?.provider === 'codex' || selected?.provider === 'claude') ? (
        <p role="alert" className="text-[11px] leading-relaxed text-secondary">
          {t('editor.accountParametersHelp')}
        </p>
      ) : null}
      <details className="field-details border-t border-solid border-t-line pt-3 my-1">
        <summary>{t('editor.modelParameters')}</summary>
        <JsonField<Record<string, unknown>>
          label={t('editor.modelParameters')}
          value={resource.parameters ?? {}}
          validate={(value) => !!value && typeof value === 'object' && !Array.isArray(value)}
          hint={t('editor.modelParametersHelp')}
          onSave={(parameters) =>
            onChange(connection, value, Object.keys(parameters).length ? parameters : null)
          }
        />
        <button
          type="button"
          className="text-button"
          disabled={!Object.keys(record(resource.parameters)).length}
          onClick={() => onChange(connection, value, null)}
        >
          {t('editor.useProviderDefaults')}
        </button>
      </details>
      {onConnect ? (
        <button className="text-button self-start" type="button" onClick={onConnect}>
          {t('editor.connectModelSources')}
          <ArrowRight size={12} />
        </button>
      ) : null}
    </section>
  );
}
