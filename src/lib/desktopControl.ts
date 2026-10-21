import { sha256, textBytes } from './bytes';
import { readBackup, type State } from './storage';
import type { PackageFile, Workspace } from './types';
import { parsePipeline, validatePipeline } from './validation';

export class DesktopControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const workspaceRevision = (workspace: Workspace) =>
  sha256(textBytes(JSON.stringify(workspace)));

export function rollbackControlChange(previous: State, proposed: State, current: State): State {
  const changed = new Set(
    [...previous.workspaces, ...proposed.workspaces]
      .filter(
        (workspace) =>
          previous.workspaces.find((item) => item.id === workspace.id) !==
          proposed.workspaces.find((item) => item.id === workspace.id),
      )
      .map((workspace) => workspace.id),
  );
  const content = (workspace?: Workspace) =>
    workspace &&
    JSON.stringify([
      workspace.source,
      workspace.savedSource,
      workspace.entrypoint,
      workspace.files,
    ]);
  const recoverable = new Set(
    [...changed].filter(
      (id) =>
        content(current.workspaces.find((item) => item.id === id)) ===
        content(proposed.workspaces.find((item) => item.id === id)),
    ),
  );
  const workspaces = current.workspaces.flatMap((workspace) => {
    if (!recoverable.has(workspace.id)) return [workspace];
    const original = previous.workspaces.find((item) => item.id === workspace.id);
    return original
      ? [{ ...original, ...(workspace.positions ? { positions: workspace.positions } : {}) }]
      : [];
  });
  for (const workspace of previous.workspaces)
    if (recoverable.has(workspace.id) && !workspaces.some((item) => item.id === workspace.id))
      workspaces.push(workspace);
  return {
    ...current,
    workspaces,
    activeId:
      current.activeId === proposed.activeId &&
      (!changed.has(current.activeId) || recoverable.has(current.activeId))
        ? previous.activeId
        : current.activeId,
    engineUrl: current.engineUrl === proposed.engineUrl ? previous.engineUrl : current.engineUrl,
    engineMode:
      current.engineMode === proposed.engineMode ? previous.engineMode : current.engineMode,
  };
}

export async function controlWorkspace(
  state: State,
  args: Record<string, unknown>,
  compare = false,
) {
  const workspace = state.workspaces.find((item) => item.id === args.id);
  if (!workspace)
    throw new DesktopControlError(
      'not_found',
      'Pipeline not found. List pipelines to choose an existing ID.',
    );
  if (compare && args.expectedRevision !== (await workspaceRevision(workspace)))
    throw new DesktopControlError(
      'conflict',
      'Pipeline changed. Read it again and use its latest revision before editing.',
    );
  return workspace;
}

export async function applyPipelineControl(
  state: State,
  operation: string,
  args: Record<string, unknown>,
): Promise<{ state?: State; result: unknown; workspaceId?: string; activate?: boolean }> {
  if (operation === 'pipeline_list') {
    return {
      result: {
        items: await Promise.all(
          state.workspaces.map(async (workspace) => {
            const pipeline = parsePipeline(workspace.source);
            return {
              id: workspace.id,
              name: pipeline?.metadata.name,
              title: pipeline?.metadata.title ?? pipeline?.metadata.name,
              revision: await workspaceRevision(workspace),
              dirty: workspace.source !== workspace.savedSource,
            };
          }),
        ),
      },
    };
  }
  const current =
    operation === 'pipeline_create'
      ? undefined
      : await controlWorkspace(
          state,
          args,
          ['pipeline_update', 'pipeline_delete'].includes(operation),
        );
  if (operation === 'pipeline_get' && current)
    return { result: { workspace: current, revision: await workspaceRevision(current) } };
  if (operation === 'pipeline_validate' && current) {
    const check = validatePipeline(current.source, current.files, current.entrypoint);
    return {
      result: {
        valid: !!check.pipeline && !check.diagnostics.some((item) => item.severity === 'error'),
        diagnostics: check.diagnostics,
      },
    };
  }
  if (!['pipeline_create', 'pipeline_update', 'pipeline_delete'].includes(operation))
    throw new DesktopControlError('invalid', 'Unsupported pipeline operation.');
  if (current && current.source !== current.savedSource && args.allowDirty !== true)
    throw new DesktopControlError(
      'dirty',
      'This pipeline has unsaved changes. Read its draft and explicitly set allowDirty to replace or delete it.',
    );
  if (operation === 'pipeline_delete' && current) {
    const workspaces = state.workspaces.filter((item) => item.id !== current.id);
    return {
      state: {
        ...state,
        workspaces,
        activeId: state.activeId === current.id ? (workspaces[0]?.id ?? '') : state.activeId,
      },
      result: { deleted: current.id },
    };
  }
  if (operation === 'pipeline_create' && typeof args.source !== 'string')
    throw new DesktopControlError(
      'invalid',
      'Provide pipeline YAML in source. Read knotra://schema/v1 for its format.',
    );
  if (args.source !== undefined && typeof args.source !== 'string')
    throw new DesktopControlError('invalid', 'Pipeline source must be text.');
  if (args.entrypoint !== undefined && typeof args.entrypoint !== 'string')
    throw new DesktopControlError('invalid', 'Entrypoint must be a package-relative path.');
  if (args.files !== undefined && !Array.isArray(args.files))
    throw new DesktopControlError(
      'invalid',
      'Files must be a list of package-relative paths and base64 content.',
    );
  if (
    args.positions !== undefined &&
    (!args.positions || typeof args.positions !== 'object' || Array.isArray(args.positions))
  )
    throw new DesktopControlError(
      'invalid',
      'Positions must map block IDs to x and y coordinates.',
    );
  const source = (args.source as string | undefined) ?? current?.source;
  if (typeof source !== 'string')
    throw new DesktopControlError('invalid', 'Provide pipeline YAML in source.');
  const workspace: Workspace = {
    ...current,
    id: current?.id ?? crypto.randomUUID(),
    entrypoint: (args.entrypoint as string | undefined) ?? current?.entrypoint ?? 'pipeline.yaml',
    source,
    savedSource: source,
    files: (args.files as PackageFile[] | undefined) ?? current?.files ?? [],
    ...(args.positions === undefined
      ? {}
      : { positions: args.positions as Workspace['positions'] }),
    updatedAt: new Date().toISOString(),
  };
  const workspaces = current
    ? state.workspaces.map((item) => (item.id === current.id ? workspace : item))
    : [...state.workspaces, workspace];
  const activate = args.activate !== false;
  const next = { ...state, workspaces, activeId: activate ? workspace.id : state.activeId };
  // Reuse backup/package limits so MCP cannot bypass the desktop's path and byte checks.
  readBackup(JSON.stringify(next));
  const check = validatePipeline(source, workspace.files, workspace.entrypoint);
  if (!check.pipeline)
    throw new DesktopControlError(
      'invalid',
      check.diagnostics.find((item) => item.severity === 'error')?.message ??
        'Pipeline YAML does not match the contract.',
    );
  return {
    state: next,
    result: {
      workspace,
      revision: await workspaceRevision(workspace),
      diagnostics: check.diagnostics,
    },
    workspaceId: workspace.id,
    activate,
  };
}

export function controlEditorBusy(): boolean {
  const field = document.activeElement;
  return (
    field instanceof HTMLElement &&
    field.matches('input, textarea, [contenteditable="true"]') &&
    !!field.closest('.setup-inspector, .source-editor, .cm-editor, .workspace')
  );
}
