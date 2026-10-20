import {
  ArrowLeft,
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Fingerprint,
  Inbox,
  ListFilter,
  Play,
  Search,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import SourceEditor from '../../components/editor/SourceEditor';
import GraphView from '../../components/graph/GraphView';
import { Empty, Status, size, time } from '../../components/ui';
import { briefFor } from '../../lib/demo';
import { demoStatusLabels, executionTabLabels } from '../../lib/executionLabels';
import { useI18n } from '../../lib/i18n';
import type { Artifact, DemoRun, Json } from '../../lib/types';
import { parsePipeline } from '../../lib/validation';

export function RunsView({
  runs,
  activeId,
  onSelect,
  onCancel,
  onReview,
  onStart,
}: {
  runs: DemoRun[];
  activeId?: string;
  onSelect: (id?: string) => void;
  onCancel: (id: string) => void;
  onReview: (id: string) => void;
  onStart: () => void;
}) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('timeline');
  const run = runs.find((r) => r.id === activeId);
  const pipeline = run ? parsePipeline(run.source) : undefined;
  if (run)
    return (
      <div className="run-detail h-full flex flex-col min-h-0">
        <div className="run-heading flex items-center justify-between mt-5.25 mb-0 mx-7.5">
          <button type="button" className="text-button" onClick={() => onSelect(undefined)}>
            <ArrowLeft size={15} />
            {t('execution.allRuns')}
          </button>
          <span className="demo-tag text-[9px] border border-solid border-line rounded-[4px] text-secondary tracking-[0.4px] bg-[rgb(var(--accent-rgb)_/_0.063)] px-1.5 py-0.75">
            {t('execution.demoRun')}
          </span>
        </div>
        <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
          <div>
            <h1>{run.topic}</h1>
            <p>
              {run.title}
              <span className="separator text-subtle mx-2 my-0">/</span>
              {time(run.createdAt, locale)}
              <span className="separator text-subtle mx-2 my-0">/</span>
              <code>{run.id.slice(0, 8)}</code>
            </p>
          </div>
          <div className="heading-actions flex items-center gap-2.5">
            <Status status={run.status} />
            {run.status === 'waiting_human' ? (
              <button type="button" className="button primary" onClick={() => onReview(run.id)}>
                {t('execution.reviewRequest')}
                <ArrowUpRight size={15} />
              </button>
            ) : null}
            {['running', 'waiting_human'].includes(run.status) ? (
              <button type="button" className="button" onClick={() => onCancel(run.id)}>
                <XCircle size={15} />
                {t('common.cancel')}
              </button>
            ) : null}
          </div>
        </header>
        <div className="notice small text-[11px] flex items-start gap-3 border border-solid border-line-strong rounded-[16px] bg-[rgb(var(--accent-rgb)_/_0.027)] text-accent mb-6.25 px-5 py-4.5">
          {t('execution.thisGuidedDemoUsesSampleOutputsNoProviders')}
        </div>
        <div className="run-content flex flex-col flex-1 min-h-0 mt-0 mb-5 border border-solid border-line rounded-[20px] overflow-hidden mx-7.5">
          {pipeline ? (
            <div className="run-graph flex flex-1 min-h-45">
              <GraphView graph={pipeline.spec} statuses={run.nodes} onSelect={() => {}} />
            </div>
          ) : null}
          <div className="run-bottom bg-surface h-[clamp(170px,_28vh,_270px)] shrink-0 flex flex-col border-t border-solid border-t-line">
            <div className="underline-tabs flex border-b border-solid border-b-line gap-5.25 shrink-0 px-5.25 py-0">
              {['timeline', 'inputs', 'outputs', 'snapshot'].map((tabName) => (
                <button
                  type="button"
                  key={tabName}
                  className={tab === tabName ? 'active' : ''}
                  onClick={() => setTab(tabName)}
                >
                  {t(executionTabLabels[tabName] ?? tabName)}
                </button>
              ))}
            </div>
            {tab === 'timeline' ? (
              <div className="timeline overflow-auto min-h-0 px-5.25 py-4.5">
                {run.events.map((e) => (
                  <div
                    key={e.id}
                    className="timeline-event flex items-start gap-3.25 relative px-0 py-2"
                  >
                    <span className="timeline-marker w-1.25 h-1.25 mt-1.75 rounded-full bg-surface-highlight shrink-0" />
                    <time>
                      {new Date(e.at).toLocaleTimeString(locale === 'ru' ? 'ru-RU' : 'en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </time>
                    <div>
                      {e.node ? <strong>{e.node}</strong> : null}
                      <p>{e.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : tab === 'snapshot' ? (
              <div className="snapshot-editor h-full min-h-0">
                <SourceEditor
                  source={run.source}
                  readOnly
                  label={t('execution.immutableRunSnapshot')}
                />
              </div>
            ) : (
              <pre className="json-view text-muted overflow-auto min-h-0 text-[11px] p-5.5 m-0">
                {JSON.stringify(tab === 'inputs' ? run.inputs : run.outputs, null, 2)}
              </pre>
            )}
          </div>
        </div>
      </div>
    );
  const filtered = runs.filter(
    (r) =>
      (filter === 'all' || r.status === filter) &&
      `${r.topic} ${r.id} ${r.title}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="page pb-8.75 min-h-full">
      <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <div className="breadcrumb text-[10px] text-muted flex items-center gap-2.25 mb-3">
            {t('resources.workspace')}
            <ChevronRight size={13} />
            {t('execution.history')}
          </div>
          <h1>{t('execution.runHistory')}</h1>
          <p>{t('execution.followTheWorkInspectTheOutputsAndPick')}</p>
        </div>
        <button type="button" className="button primary" onClick={onStart}>
          <Play size={15} />
          {t('execution.tryTheGuidedDemo')}
        </button>
      </header>
      <div className="summary-cards grid grid-cols-[repeat(4,_1fr)] gap-0 mb-7 border border-solid border-line rounded-[20px] [background:radial-gradient(ellipse_at_95%_0,_rgb(var(--violet-rgb)_/_0.165),_transparent_55%),_var(--surface)] overflow-hidden">
        <div>
          <span>{t('execution.totalRuns')}</span>
          <strong>{runs.length}</strong>
          <small>{t('execution.localDemoHistory')}</small>
        </div>
        <div>
          <span>{t('execution.inProgress')}</span>
          <strong>{runs.filter((r) => r.status === 'running').length}</strong>
          <small>{t('execution.workIsMovingForward')}</small>
        </div>
        <div>
          <span>{t('execution.needsYourAttention')}</span>
          <strong>{runs.filter((r) => r.status === 'waiting_human').length}</strong>
          <small>{t('execution.humanReviewRequests')}</small>
        </div>
        <div>
          <span>{t('execution.completed')}</span>
          <strong>{runs.filter((r) => r.status === 'succeeded').length}</strong>
          <small>{t('execution.outputsReadyToInspect')}</small>
        </div>
      </div>
      <div className="list-toolbar runs-toolbar flex items-center justify-start gap-3 mb-5">
        <label className="search-field flex items-center gap-3 text-secondary border border-solid border-line rounded-[16px] w-100 bg-surface px-4.5 py-0">
          <Search size={16} />
          <input
            aria-label={t('execution.searchRuns')}
            placeholder={t('execution.searchRuns2')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="status-filter">
          <ListFilter size={16} aria-hidden="true" />
          <select
            aria-label={t('execution.filterRunsByStatus')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">{t(demoStatusLabels.all)}</option>
            <option value="running">{t(demoStatusLabels.running)}</option>
            <option value="waiting_human">{t(demoStatusLabels.waiting_human)}</option>
            <option value="succeeded">{t(demoStatusLabels.succeeded)}</option>
            <option value="cancelled">{t(demoStatusLabels.cancelled)}</option>
          </select>
          <ChevronDown size={15} aria-hidden="true" />
        </label>
      </div>
      {filtered.length ? (
        <div className="run-table border border-solid border-line rounded-[20px] overflow-hidden bg-surface">
          <div className="table-header grid grid-cols-[minmax(230px,_1.8fr)_1fr_1fr_100px] gap-5 items-center pt-6.5 pb-5 w-full text-left text-[12px] tracking-[0] text-muted bg-transparent [border-bottom:0] px-5.25">
            <span>{t('execution.pipelineTopic')}</span>
            <span>{t('execution.status')}</span>
            <span>{t('execution.started')}</span>
            <span>{t('execution.mode')}</span>
          </div>
          {filtered.map((r) => (
            <button
              type="button"
              className="run-table-row grid grid-cols-[minmax(230px,_1.8fr)_1fr_1fr_100px] gap-5 items-center w-full text-left [border-bottom:0] px-5.25 py-6.5"
              key={r.id}
              onClick={() => onSelect(r.id)}
            >
              <span className="run-name flex items-center gap-3.25">
                <span className="run-list-icon grid place-items-center w-9.5 h-9.5 rounded-full bg-transparent border border-solid border-line-strong text-foreground">
                  <Play size={17} />
                </span>
                <span>
                  <strong>{r.topic}</strong>
                  <small>
                    {r.title} · {r.id.slice(0, 8)}
                  </small>
                </span>
              </span>
              <Status status={r.status} />
              <span className="muted small text-[11px] text-muted">
                {time(r.createdAt, locale)}
              </span>
              <span className="inline-row flex items-center gap-2.5">
                <span className="demo-tag text-[9px] border border-solid border-line rounded-[4px] text-secondary tracking-[0.4px] bg-[rgb(var(--accent-rgb)_/_0.063)] px-1.5 py-0.75">
                  {t('execution.demo')}
                </span>
                <ChevronRight size={15} />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          icon={<Clock3 size={30} />}
          title={runs.length ? t('execution.noMatchingRuns') : t('execution.noRunsYet')}
          action={
            !runs.length ? (
              <button type="button" className="button" onClick={onStart}>
                {t('execution.exploreTheDemo')}
                <ArrowUpRight size={15} />
              </button>
            ) : undefined
          }
        >
          {runs.length
            ? t('execution.tryADifferentSearchOrStatusFilter')
            : t('execution.startAResearchBriefDemoToSeeEvents')}
        </Empty>
      )}
    </section>
  );
}

export function InboxView({
  runs,
  onRespond,
  onRun,
}: {
  runs: DemoRun[];
  onRespond: (id: string, request: string, response: Record<string, Json>) => void;
  onRun: (id: string) => void;
}) {
  const { t, locale, message } = useI18n();
  const waiting = runs.filter((r) => r.status === 'waiting_human');
  const [selected, setSelected] = useState<string>();
  const [feedback, setFeedback] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState('{\n  "feedback": "Looks good. Ready to share."\n}');
  const [error, setError] = useState('');
  const [jsonError, setJsonError] = useState(false);
  const run = waiting.find((r) => r.id === selected) ?? waiting[0];
  function submit() {
    if (!run?.requestId) return;
    try {
      const response = advanced ? JSON.parse(json) : { feedback };
      onRespond(run.id, run.requestId, response);
      setFeedback('');
      setError('');
      setJsonError(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setJsonError(e instanceof SyntaxError);
    }
  }
  return (
    <section className="page inbox-page pb-8.75 min-h-full">
      <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <div className="breadcrumb text-[10px] text-muted flex items-center gap-2.25 mb-3">
            {t('resources.workspace')}
            <ChevronRight size={13} />
            {t('execution.humanInTheLoop')}
          </div>
          <h1>{t('execution.humanReview')}</h1>
          <p>{t('execution.reviewTheContextYourResponseBelongsToOne')}</p>
        </div>
        <span className="count-pill text-[10px] text-muted border border-solid border-line bg-surface rounded-[6px] px-2.75 py-2">
          {t(waiting.length === 1 ? 'execution.countOpenRequest' : 'execution.countOpenRequests', {
            count: waiting.length,
          })}
        </span>
      </header>
      {run ? (
        <div className="inbox-layout flex gap-6.25 mx-7.5 my-0">
          <div className="request-list w-58.75 shrink-0">
            {waiting.map((r) => (
              <button
                type="button"
                key={r.id}
                className={r.id === run.id ? 'active' : ''}
                onClick={() => {
                  setSelected(r.id);
                  setError('');
                  setFeedback('');
                }}
              >
                <span className="request-icon grid place-items-center w-8 h-8 rounded-[8px] bg-[rgb(var(--danger-rgb)_/_0.078)] border border-solid border-[rgb(var(--danger-rgb)_/_0.188)] text-danger mb-1.25">
                  <Inbox size={17} />
                </span>
                <strong>{r.topic}</strong>
                <small>{t('execution.researchBriefReview')}</small>
                <time>{time(r.updatedAt, locale)}</time>
                <span className="demo-tag text-[9px] border border-solid border-line rounded-[4px] text-secondary tracking-[0.4px] bg-[rgb(var(--accent-rgb)_/_0.063)] px-1.5 py-0.75">
                  {t('execution.demo')}
                </span>
              </button>
            ))}
          </div>
          <div className="review-card flex-1 min-w-0 bg-surface border border-solid border-line rounded-[20px] overflow-hidden">
            <header>
              <div>
                <span className="eyebrow text-[9px] tracking-[1.3px] text-muted font-medium">
                  {t('execution.humanReview2')}
                </span>
                <h2>{t('execution.reviewTheGeneratedBrief')}</h2>
              </div>
              <button type="button" className="text-button" onClick={() => onRun(run.id)}>
                {t('execution.viewRun')}
                <ArrowUpRight size={14} />
              </button>
            </header>
            <p className="review-prompt text-[11px] text-muted whitespace-pre-wrap wrap-anywhere mx-6.75 my-5.25">
              {t('execution.reviewTheBriefAndReturnYourFeedbackYour')}
            </p>
            <div className="brief-preview border border-solid border-line rounded-[8px] mt-0 mb-6.25 bg-base p-6.5 mx-6.75">
              {briefFor(run)
                .split('\n')
                .map((line, i) =>
                  line.startsWith('# ') ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: A saved brief is immutable; line positions identify its static preview.
                    <h2 key={i}>{line.slice(2)}</h2>
                  ) : line.startsWith('## ') ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: A saved brief is immutable; line positions identify its static preview.
                    <h3 key={i}>{line.slice(3)}</h3>
                  ) : line.startsWith('- ') ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: A saved brief is immutable; line positions identify its static preview.
                    <p className="brief-bullet" key={i}>
                      • {line.slice(2)}
                    </p>
                  ) : line ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: A saved brief is immutable; line positions identify its static preview.
                    <p key={i}>{line}</p>
                  ) : null,
                )}
            </div>
            <div className="response-form bg-surface border-t border-solid border-t-line px-6.75 py-5.75">
              <div className="inline-row spread flex items-center gap-2.5 justify-between">
                <label htmlFor="review-feedback">{t('execution.yourFeedback')}</label>
                <button
                  type="button"
                  className="text-button small text-[11px]"
                  onClick={() => setAdvanced(!advanced)}
                >
                  <Braces size={13} />
                  {advanced ? t('execution.simpleResponse') : t('execution.jsonResponse')}
                </button>
              </div>
              {advanced ? (
                <textarea
                  aria-label={t('execution.reviewJsonResponse')}
                  rows={5}
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  className="code-input [font-family:ui-monospace,_monospace]"
                />
              ) : (
                <textarea
                  id="review-feedback"
                  placeholder={t('execution.whatShouldBeKeptClarifiedOrImproved')}
                  rows={4}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                />
              )}
              {error ? (
                <p
                  className="form-error text-secondary text-[11px] leading-[1.8] mt-2.5 whitespace-pre-wrap"
                  role="alert"
                >
                  {jsonError
                    ? t('execution.invalidJsonMessage', { message: error })
                    : error
                        .split('\n')
                        .map((line) => message(line))
                        .join('\n')}
                </p>
              ) : null}
              <div className="response-footer flex items-center justify-between gap-3.75 mt-4.25">
                <small>
                  <Fingerprint size={13} />
                  {t('execution.requestId', { id: run.requestId?.slice(0, 8) ?? '' })}
                </small>
                <button
                  type="button"
                  className="button primary"
                  onClick={submit}
                  disabled={!advanced && !feedback.trim()}
                >
                  <Check size={16} />
                  {t('execution.submitResponse')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <Empty icon={<Inbox size={30} />} title={t('execution.youReAllCaughtUp')}>
          {t('execution.whenAPipelineReachesAHumanNodeThe')}
        </Empty>
      )}
    </section>
  );
}

export function ArtifactsView({
  runs,
  onExport,
}: {
  runs: DemoRun[];
  onExport: (artifact: Artifact) => void;
}) {
  const { t, locale } = useI18n();
  const artifacts = runs.flatMap((r) => r.artifacts.map((a) => ({ ...a, run: r })));
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const filtered = artifacts.filter((a) =>
    `${a.name} ${a.run.topic}`.toLowerCase().includes(query.toLowerCase()),
  );
  const artifact = filtered.find((a) => a.id === selected);
  return (
    <section className="page pb-8.75 min-h-full">
      <header className="page-heading flex items-center justify-between gap-5 pt-5 pb-7.5 shrink-0 px-8">
        <div>
          <div className="breadcrumb text-[10px] text-muted flex items-center gap-2.25 mb-3">
            {t('resources.workspace')}
            <ChevronRight size={13} />
            {t('execution.outputs')}
          </div>
          <h1>{t('navigation.artifacts')}</h1>
          <p>{t('execution.declaredFilesPreservedBytesAndATraceableOrigin')}</p>
        </div>
        <span className="count-pill text-[10px] text-muted border border-solid border-line bg-surface rounded-[6px] px-2.75 py-2">
          {t('execution.countArtifacts', { count: artifacts.length })}
        </span>
      </header>
      <div className="list-toolbar flex items-center justify-between gap-5 mb-5">
        <label className="search-field flex items-center gap-3 text-secondary border border-solid border-line rounded-[16px] w-100 bg-surface px-4.5 py-0">
          <Search size={16} />
          <input
            placeholder={t('execution.searchArtifacts2')}
            aria-label={t('execution.searchArtifacts')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="small muted text-[11px] text-muted">
          {t('execution.sampleArtifactsFromDemoRuns')}
        </span>
      </div>
      {filtered.length ? (
        <div className="artifact-layout flex gap-5.75 items-start">
          <div className="artifact-grid grid grid-cols-[repeat(auto-fill,_minmax(205px,_1fr))] gap-4.5 flex-1">
            {filtered.map((a) => (
              <button
                type="button"
                key={a.id}
                className={`artifact-card border border-solid border-line rounded-[20px] bg-surface overflow-hidden text-left flex flex-col p-0 ${selected === a.id ? 'selected' : ''}`}
                onClick={() => setSelected(a.id)}
              >
                <div className="artifact-thumbnail h-38.75 w-full flex items-center justify-center [background:radial-gradient(ellipse_at_50%_40%,_rgb(var(--accent-rgb)_/_0.173),_transparent_70%),_linear-gradient(130deg,_var(--surface),_var(--base))] text-muted relative">
                  <FileText size={38} />
                  <span>MD</span>
                </div>
                <div className="artifact-info flex flex-col gap-2.5 p-4.75">
                  <strong>{a.name}</strong>
                  <span>{a.run.topic}</span>
                  <small>
                    {size(a.size, locale)} · {a.mediaType}
                  </small>
                </div>
                <div className="artifact-footer flex items-center justify-between w-full border-t border-solid border-t-line text-muted px-4.75 py-2.75">
                  <span className="demo-tag text-[9px] border border-solid border-line rounded-[4px] text-secondary tracking-[0.4px] bg-[rgb(var(--accent-rgb)_/_0.063)] px-1.5 py-0.75">
                    {t('execution.demo')}
                  </span>
                  <ArrowUpRight size={15} />
                </div>
              </button>
            ))}
          </div>
          {artifact ? (
            <aside className="artifact-inspector w-80 min-w-0 shrink-0 border border-solid border-line rounded-[12px] bg-surface p-5.5">
              <div className="inline-row spread flex items-center gap-2.5 justify-between">
                <h3>{artifact.name}</h3>
                <button
                  type="button"
                  className="button small-button text-[11px] min-h-8 px-3 py-1.75"
                  onClick={() => onExport(artifact)}
                >
                  <Download size={14} />
                  {t('common.export')}
                </button>
              </div>
              <div className="detail-field flex flex-col gap-2.25 mb-5.75">
                <span>SHA-256</span>
                <code className="hash text-[10px]! leading-[1.9]">{artifact.sha256}</code>
              </div>
              <div className="detail-field flex flex-col gap-2.25 mb-5.75">
                <span>{t('execution.origin')}</span>
                <strong>{artifact.run.topic}</strong>
                <small>{t('execution.demoRunId', { id: artifact.run.id.slice(0, 8) })}</small>
              </div>
              <pre className="artifact-text text-[11px] text-muted mt-6.25 mb-0 border-t border-solid border-t-line pt-5.25 leading-[1.9] mx-0">
                {artifact.content}
              </pre>
            </aside>
          ) : null}
        </div>
      ) : (
        <Empty
          icon={<FileText size={30} />}
          title={
            artifacts.length
              ? t('execution.noMatchingArtifacts')
              : t('execution.yourOutputsLiveHere')
          }
        >
          {artifacts.length
            ? t('execution.tryADifferentFileNameOrResearchTopic')
            : t('execution.completeAResearchBriefDemoAndItsMarkdown')}
        </Empty>
      )}
    </section>
  );
}
