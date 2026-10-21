import { stringify } from 'yaml';
import { fromExample } from './examples';
import { type Locale, translate } from './i18n';

export function createLearningWorkspace(locale: Locale) {
  return fromExample(
    {
      id: 'learning',
      category: 'starter',
      titleKey: 'tour.pipeline.title',
      descriptionKey: 'tour.pipeline.description',
      kindKey: 'shell.llm',
      requirements: ['model'],
      files: [],
      source: stringify({
        apiVersion: 'knotra/v1',
        kind: 'Pipeline',
        metadata: { name: 'my-first-pipeline' },
        spec: {
          models: { writer: { connection: 'model_main' } },
          inputs: {
            question: {
              schema: { type: 'string' },
              default: translate('tour.pipeline.question', locale),
            },
          },
          nodes: {
            answer: {
              type: 'llm',
              inputs: {
                question: { schema: { type: 'string' }, bind: { from: 'inputs.question' } },
              },
              llm: { model: 'writer', prompt: { text: translate('tour.pipeline.prompt', locale) } },
              outputs: { text: { schema: { type: 'string' } } },
            },
          },
          outputs: {
            answer: { schema: { type: 'string' }, bind: { from: 'nodes.answer.outputs.text' } },
          },
        },
      }),
    },
    locale,
  );
}
