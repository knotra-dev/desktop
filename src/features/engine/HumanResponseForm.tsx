import { useId, useState } from 'react';
import {
  humanResponseFields,
  humanResponseFitsFields,
  parseHumanResponse,
  updateHumanResponse,
} from '../../lib/humanResponse';
import { useI18n } from '../../lib/i18n';

const familiarLabels: Record<string, string> = {
  answer: 'execution.responseAnswer',
  response: 'execution.responseAnswer',
  text: 'execution.responseAnswer',
  feedback: 'execution.responseFeedback',
  comment: 'execution.responseFeedback',
  comments: 'execution.responseFeedback',
  approved: 'execution.responseApproval',
  approval: 'execution.responseApproval',
  decision: 'execution.responseDecision',
  reason: 'execution.responseReason',
};

export function HumanResponseForm({
  schema,
  value,
  onChange,
  disabled,
  jsonLabel,
  draftHelp,
}: {
  schema: unknown;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  jsonLabel?: string;
  draftHelp?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const [advanced, setAdvanced] = useState(false);
  const fields = humanResponseFields(schema);
  const response = parseHumanResponse(value);
  const canUseFields = !!(fields && response && humanResponseFitsFields(response, fields));
  const raw = advanced || !canUseFields;
  const number = (value: unknown) => (typeof value === 'number' ? value : undefined);

  return (
    <div className="flex flex-col gap-4">
      {canUseFields && !raw
        ? fields.map((field) => {
            const current = response[field.name];
            const title =
              typeof field.schema.title === 'string' && field.schema.title.trim()
                ? field.schema.title
                : Object.hasOwn(familiarLabels, field.name)
                  ? t(familiarLabels[field.name])
                  : field.name.replace(/[_-]+/g, ' ');
            const fieldId = `${id}-${field.name}`;
            const description =
              typeof field.schema.description === 'string' ? field.schema.description : '';
            const choices: (string | number | boolean)[] | undefined =
              field.choices ?? (field.type === 'boolean' ? [true, false] : undefined);
            const minimum = Math.max(
              number(field.schema.minimum) ?? -Infinity,
              number(field.schema.exclusiveMinimum) ?? -Infinity,
            );
            const maximum = Math.min(
              number(field.schema.maximum) ?? Infinity,
              number(field.schema.exclusiveMaximum) ?? Infinity,
            );
            const change = (next: string | number | boolean | undefined) =>
              onChange(updateHumanResponse(value, field.name, next));
            const shared = {
              id: fieldId,
              'aria-label': title,
              disabled,
              'aria-describedby': description ? `${fieldId}-hint` : undefined,
            };
            return (
              <label
                className="field flex flex-col gap-2 text-muted text-[12px] leading-relaxed"
                htmlFor={fieldId}
                key={field.name}
              >
                <span className="font-medium text-ink">
                  {title}
                  {!field.required && (
                    <span className="ml-1 font-normal text-muted">
                      {t('execution.responseOptional')}
                    </span>
                  )}
                </span>
                {choices ? (
                  <select
                    {...shared}
                    className="h-11 w-full"
                    required={field.required}
                    value={
                      current === undefined
                        ? ''
                        : String(choices.indexOf(current as string | number | boolean))
                    }
                    onChange={(event) =>
                      change(
                        event.target.value === '' ? undefined : choices[Number(event.target.value)],
                      )
                    }
                  >
                    <option value="">{t('execution.responseChoose')}</option>
                    {choices.map((choice, index) => (
                      <option key={`${typeof choice}:${choice}`} value={index}>
                        {typeof choice === 'boolean'
                          ? t(choice ? 'execution.responseYes' : 'execution.responseNo')
                          : String(choice)}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'string' ? (
                  <textarea
                    {...shared}
                    rows={4}
                    className="min-h-28 resize-y text-[13px] leading-relaxed"
                    required={
                      field.required &&
                      (current === undefined || (number(field.schema.minLength) ?? 0) > 0)
                    }
                    value={typeof current === 'string' ? current : ''}
                    onChange={(event) =>
                      change(
                        !field.required && event.target.value === ''
                          ? undefined
                          : event.target.value,
                      )
                    }
                  />
                ) : (
                  <input
                    {...shared}
                    className="h-11 w-full"
                    type="number"
                    required={field.required}
                    min={
                      Number.isFinite(minimum)
                        ? field.type === 'integer'
                          ? Math.ceil(minimum)
                          : minimum
                        : undefined
                    }
                    max={
                      Number.isFinite(maximum)
                        ? field.type === 'integer'
                          ? Math.floor(maximum)
                          : maximum
                        : undefined
                    }
                    step={field.type === 'integer' ? 1 : 'any'}
                    value={typeof current === 'number' ? current : ''}
                    onChange={(event) =>
                      change(event.target.value === '' ? undefined : event.target.valueAsNumber)
                    }
                  />
                )}
                {description && (
                  <span id={`${fieldId}-hint`} className="text-[11px] font-normal text-muted">
                    {description}
                  </span>
                )}
              </label>
            );
          })
        : null}
      {!canUseFields && (
        <p className="text-[12px] leading-relaxed text-muted">
          {draftHelp ??
            t(fields ? 'execution.responseDraftNeedsJson' : 'execution.responseNeedsJson')}
        </p>
      )}
      {(canUseFields || advanced) && (
        <button
          type="button"
          className="text-button self-start text-[11px]"
          aria-expanded={raw}
          aria-controls={`${id}-json`}
          disabled={disabled || !canUseFields}
          onClick={() => setAdvanced(!advanced)}
        >
          {t(advanced ? 'execution.responseUseFields' : 'execution.responseAdvanced')}
        </button>
      )}
      {raw && (
        <label className="field flex flex-col gap-2 text-muted text-[11px] leading-relaxed">
          {t('execution.responseAdvanced')}
          <textarea
            id={`${id}-json`}
            aria-label={jsonLabel ?? t('execution.engineReviewResponse')}
            className="code-input [font-family:ui-monospace,_monospace]"
            rows={7}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}
    </div>
  );
}
