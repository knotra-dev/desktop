import { ArrowRight, Braces, Copy, Plus, Settings2, Trash2, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { NodeIcon, nodeMeta } from '../../components/ui';
import { nodePorts } from '../../lib/graph';
import { useI18n } from '../../lib/i18n';
import { type Graph, type NodeDefinition, type Pipeline, record } from '../../lib/types';
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
  const { message } = useI18n();
  const inputId = useId();
  const [error, setError] = useState('');
  const props = {
    id: inputId,
    'aria-label': label,
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
      {label}
      {multiline ? <textarea key={value} rows={5} {...props} /> : <input key={value} {...props} />}
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

export default function Inspector({
  id,
  node,
  graph,
  resources,
  files,
  onEdit,
  onSource,
  onDuplicate,
  onRemove,
  onBody,
  importedGraphs,
  onWorkflow,
  showPorts,
}: {
  id?: string;
  node?: NodeDefinition;
  graph: Graph;
  resources: Pipeline['spec'];
  files: string[];
  importedGraphs?: Map<string, Graph>;
  onEdit: (key: string, value: unknown) => void;
  onSource: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onBody: () => void;
  onWorkflow?: () => void;
  showPorts?: boolean;
  onNotify?: (message: string) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'setup' | 'ports'>('setup');
  useEffect(() => {
    if (showPorts) setTab('ports');
  }, [showPorts]);
  if (!node || !id) return null;
  const meta = nodeMeta[node.type];
  const config = record(node[node.type]);
  const cases = config.cases as { name: string; when: string }[];
  const prompt = record(config.prompt);
  const outputs = nodePorts(node, importedGraphs);
  const editConfig = (key: string, value: unknown) =>
    onEdit(node.type, { ...config, [key]: value });
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
        <small>{t('editor.usesAResourceDeclaredInThisWorkflow')}</small>
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
    <aside className="inspector setup-inspector w-85 shrink-0 overflow-hidden border-l border-solid border-l-line bg-surface flex flex-col">
      <header className="inspector-header flex items-center justify-between pt-4 pb-2 px-4.5">
        <span className="eyebrow text-[9px] tracking-[1.3px] text-muted font-medium">
          {t('editor.blockSettings')}
        </span>
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
      <div className="inspector-title pt-4.5 pb-5.75 [background:radial-gradient(ellipse_at_0_50%,_rgb(var(--accent-rgb)_/_0.063),_transparent_80%)] px-5.25">
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
        {tab === 'setup' ? (
          <>
            <TextField
              label={t('editor.description')}
              value={node.description ?? ''}
              optional
              onSave={(value) => onEdit('description', value || undefined)}
            />
            {['llm', 'agent'].includes(node.type)
              ? resourceSelect(
                  t('editor.modelAlias'),
                  'models',
                  String(config.model ?? ''),
                  (value) => editConfig('model', value),
                )
              : null}
            {['agent', 'code'].includes(node.type)
              ? resourceSelect(t('editor.sandbox'), 'sandboxes', node.sandbox ?? '', (value) =>
                  onEdit('sandbox', value),
                )
              : null}
            {['llm', 'agent', 'human'].includes(node.type) ? (
              <>
                <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                  {t('editor.promptSource')}
                  <select
                    value={prompt.file ? 'file' : 'text'}
                    onChange={(event) => {
                      if (event.target.value === 'text')
                        editConfig('prompt', { text: 'Describe the task to complete.' });
                      else {
                        const file = files.find((file) => !/\.ya?ml$/.test(file));
                        if (file) editConfig('prompt', { file });
                      }
                    }}
                  >
                    <option value="text">{t('editor.writeInstructionsHere')}</option>
                    <option value="file" disabled={!files.some((file) => !/\.ya?ml$/.test(file))}>
                      {t('editor.packageFile')}
                    </option>
                  </select>
                </label>
                {prompt.file ? (
                  <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                    {t('editor.promptFile')}
                    <select
                      value={String(prompt.file)}
                      onChange={(event) => editConfig('prompt', { file: event.target.value })}
                    >
                      {files.map((file) => (
                        <option key={file}>{file}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <TextField
                    label={t(
                      node.type === 'human' ? 'execution.reviewRequest' : 'editor.instructions',
                    )}
                    multiline
                    value={String(prompt.text ?? '')}
                    onSave={(text) => editConfig('prompt', { text })}
                    hint={t('editor.inputsArriveAsSeparateDataDescribeTheTask')}
                  />
                )}
              </>
            ) : null}
            {node.type === 'agent' ? (
              <>
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
                {resourceSelect(t('editor.mcpServerAlias'), 'mcp', String(config.server), (value) =>
                  editConfig('server', value),
                )}
                <TextField
                  label={t('editor.toolName')}
                  value={String(config.name)}
                  onSave={(value) => editConfig('name', value)}
                  hint={t('editor.exactToolNameExposedByThisMcpServer')}
                />
                <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                  {t('editor.toolArguments')}
                  <select
                    value={'expr' in record(config.arguments) ? 'expr' : 'value'}
                    onChange={(event) =>
                      editConfig(
                        'arguments',
                        event.target.value === 'expr' ? { expr: 'args' } : { value: {} },
                      )
                    }
                  >
                    <option value="value">{t('editor.fixedJsonObject')}</option>
                    <option value="expr">{t('editor.useBlockInputsCel')}</option>
                  </select>
                </label>
                {'expr' in record(config.arguments) ? (
                  <TextField
                    label={t('editor.argumentsExpression')}
                    value={String(record(config.arguments).expr)}
                    onSave={(expr) => editConfig('arguments', { expr })}
                    hint={t('editor.argsContainsThisBlockSInputsReturnAn')}
                  />
                ) : (
                  <JsonField
                    label={t('editor.argumentsJson')}
                    value={record(config.arguments).value ?? config.arguments}
                    onSave={(value) => editConfig('arguments', { value })}
                    validate={(value) =>
                      !!value && typeof value === 'object' && !Array.isArray(value)
                    }
                    hint={t('editor.aJsonObjectWithTheToolSArgument')}
                  />
                )}
                <label className="field flex flex-col gap-2.5 text-muted text-[11px] leading-[1.5] mb-6">
                  {t('editor.responseFormat')}
                  <select
                    value={String(config.response ?? 'structured')}
                    onChange={(event) => editConfig('response', event.target.value)}
                  >
                    <option value="structured">{t('editor.structuredData')}</option>
                    <option value="content">{t('editor.contentBlocks')}</option>
                  </select>
                </label>
              </>
            ) : null}
            {node.type === 'switch' ? (
              <>
                <p className="setup-hint text-[11px] leading-[1.6] text-muted mt-0 mb-3.5 mx-0">
                  {t('editor.firstMatchingConditionWinsLaterBlocksCanRead')}
                </p>
                {cases.map((item, index) => (
                  <div
                    className="setup-group border border-dashed border-line-strong rounded-[10px] p-3.25 mx-0 my-3.5"
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
                  validate={(value) =>
                    !!value && typeof value === 'object' && !Array.isArray(value)
                  }
                  hint={t('editor.explicitModelMcpSandboxAndSecretPermissionsFor')}
                />
              </>
            ) : null}
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
          </>
        ) : (
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
        )}
      </div>
    </aside>
  );
}
