import type { DemoRun, Workspace } from '../../src/lib/types';

export function legacyRun(workspace: Workspace, topic: string): DemoRun {
  return {
    id: 'legacy-run',
    workspaceId: workspace.id,
    title: 'Research brief',
    topic,
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: '2026-01-01T10:00:00Z',
    status: 'succeeded',
    source: workspace.source,
    files: workspace.files.map((file) => ({ ...file })),
    inputs: { topic },
    nodes: { discover: 'succeeded' },
    events: [{ id: 'legacy-event', at: '2026-01-01T10:00:00Z', message: 'Saved sample output.' }],
    outputs: {},
    artifacts: [],
  };
}
