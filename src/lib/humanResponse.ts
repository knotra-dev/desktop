import { record } from './types';

type ResponsePrimitive = string | number | boolean;

export interface HumanResponseField {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  required: boolean;
  schema: Record<string, unknown>;
  choices?: ResponsePrimitive[];
}

export function humanResponseFields(schema: unknown): HumanResponseField[] | null {
  const object = record(schema);
  const properties = record(object.properties);
  if (
    object.type !== 'object' ||
    !Object.keys(properties).length ||
    ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'dependentSchemas', 'patternProperties'].some(
      (key) => key in object,
    )
  )
    return null;
  const required = Array.isArray(object.required) ? object.required : [];
  if (required.some((name) => typeof name !== 'string' || !Object.hasOwn(properties, name)))
    return null;
  const fields: HumanResponseField[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const property = record(value);
    if (['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if'].some((key) => key in property))
      return null;
    const type = property.type;
    if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean')
      return null;
    const choices = Object.hasOwn(property, 'const') ? [property.const] : property.enum;
    if (
      choices !== undefined &&
      (!Array.isArray(choices) ||
        !choices.length ||
        choices.some(
          (choice) =>
            typeof choice !== (type === 'integer' ? 'number' : type) ||
            (type === 'integer' && !Number.isInteger(choice)),
        ))
    )
      return null;
    fields.push({
      name,
      type,
      required: required.includes(name),
      schema: property,
      choices: choices as ResponsePrimitive[] | undefined,
    });
  }
  return fields;
}

export function parseHumanResponse(value: string): Record<string, unknown> | null {
  try {
    const response: unknown = JSON.parse(value);
    return response && typeof response === 'object' && !Array.isArray(response)
      ? record(response)
      : null;
  } catch {
    return null;
  }
}

export function humanResponseFitsFields(
  response: Record<string, unknown>,
  fields: HumanResponseField[],
): boolean {
  return fields.every(({ name, type, choices }) => {
    if (!Object.hasOwn(response, name)) return true;
    const value = response[name];
    return (
      typeof value === (type === 'integer' ? 'number' : type) &&
      (!choices || choices.includes(value as ResponsePrimitive))
    );
  });
}

export function updateHumanResponse(
  value: string,
  name: string,
  fieldValue: ResponsePrimitive | undefined,
): string {
  const response = parseHumanResponse(value);
  if (!response) return value;
  const next = { ...response, [name]: fieldValue };
  if (fieldValue === undefined) delete next[name];
  return JSON.stringify(next, null, 2);
}
