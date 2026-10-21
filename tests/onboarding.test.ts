import { describe, expect, it } from 'vitest';
import { translate } from '../src/lib/i18n';
import { createLearningWorkspace } from '../src/lib/onboarding';
import { validatePipeline } from '../src/lib/validation';

describe('learning pipeline', () => {
  it.each(['en', 'ru'] as const)('starts with one editable model block in %s', (locale) => {
    const workspace = createLearningWorkspace(locale);
    const validation = validatePipeline(workspace.source, workspace.files, workspace.entrypoint);
    expect(validation.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(validation.pipeline!.metadata.title).toBe(translate('tour.pipeline.title', locale));
    expect(Object.keys(validation.pipeline!.spec.nodes)).toEqual(['answer']);
    expect(validation.pipeline!.spec.nodes.answer.type).toBe('llm');
    expect(validation.pipeline!.spec.nodes.answer.inputs!.question.bind!.from).toBe(
      'inputs.question',
    );
    expect(validation.pipeline!.spec.outputs.answer.bind!.from).toBe('nodes.answer.outputs.text');
    expect(workspace.files).toEqual([]);
    expect(workspace.savedSource).toBe(workspace.source);
  });
});
