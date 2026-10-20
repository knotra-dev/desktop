import { editorStatusKeys } from '../../../lib/editorLabels';
import type { EngineEvent } from '../../../lib/engine/types';
import type { useI18n } from '../../../lib/i18n';
import { record } from '../../../lib/types';

export function eventLabel(event: EngineEvent, t: ReturnType<typeof useI18n>['t']): string {
  if (event.type === 'agent.iteration')
    return t('observe.iteration', { count: Number(record(event.data).step) || 1 });
  if (
    (event.type === 'node' || event.type === 'run') &&
    Object.hasOwn(editorStatusKeys, event.message)
  )
    return t(editorStatusKeys[event.message as keyof typeof editorStatusKeys]);
  if (event.type === 'output.validating') return t('observe.validatingOutputs');
  if (event.type === 'output.completed')
    return t(
      record(event.data).valid === true
        ? 'observe.outputsVerified'
        : 'observe.outputValidationFailed',
    );
  return event.message || event.type;
}
