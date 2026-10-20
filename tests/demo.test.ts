import { describe, expect, it } from 'vitest';
import { sha256, textBytes } from '../src/lib/bytes';
import { advanceDemo, cancelDemo, createDemoRun, finishDemo, respondDemo } from '../src/lib/demo';
import { examples, fromExample } from '../src/lib/examples';

const research = examples.find((example) => example.id === 'research')!;
const local = examples.find((example) => example.id === 'local')!;

describe('guided demo lifecycle', () => {
  it('uses an immutable snapshot, pauses for a specific human request, and hashes the final artifact', async () => {
    const workspace = fromExample(research);
    let run = createDemoRun(workspace, 'Test topic');
    const source = run.source;
    workspace.source = 'edited';
    run = advanceDemo(advanceDemo(advanceDemo(run)));
    expect(run.source).toBe(source);
    expect(run.status).toBe('waiting_human');
    expect(run.nodes.publish).toBe('pending');
    expect(() => respondDemo(run, 'wrong-id', { feedback: 'yes' })).toThrow('no longer open');
    expect(() => respondDemo(run, run.requestId!, {})).toThrow('Missing required output');
    const responded = respondDemo(run, run.requestId!, { feedback: 'Ready.' });
    expect(() => respondDemo(responded, run.requestId!, { feedback: 'second answer' })).toThrow(
      'no longer open',
    );
    const finished = await finishDemo(responded);
    expect(finished.status).toBe('succeeded');
    expect(finished.artifacts).toHaveLength(1);
    const artifact = finished.artifacts[0];
    expect(artifact.sha256).toBe(await sha256(textBytes(artifact.content)));
    expect(artifact.size).toBe(textBytes(artifact.content).length);
    expect(artifact.content).toContain('demonstration brief');
    expect(artifact.content).toContain('Ready.');
  });
  it('does not continue a cancelled run or accept its stale review', async () => {
    let run = createDemoRun(fromExample(research), 'Cancel');
    run = advanceDemo(advanceDemo(advanceDemo(run)));
    const cancelled = cancelDemo(run);
    expect(advanceDemo(cancelled)).toBe(cancelled);
    expect(await finishDemo(cancelled)).toBe(cancelled);
    expect(cancelled.artifacts).toEqual([]);
    expect(() => respondDemo(cancelled, run.requestId!, { feedback: 'late' })).toThrow();
  });
  it('refuses to simulate edited or arbitrary pipelines', () => {
    const workspace = fromExample(research);
    workspace.source += '\n# modification';
    expect(() => createDemoRun(workspace, 'x')).toThrow();
    expect(() => createDemoRun(fromExample(local), 'x')).toThrow('unchanged Research brief');
  });
});
