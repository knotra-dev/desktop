import { describe, expect, it } from 'vitest';
import {
  humanResponseFields,
  humanResponseFitsFields,
  parseHumanResponse,
  updateHumanResponse,
} from '../src/lib/humanResponse';

const schema = {
  type: 'object',
  required: ['answer', 'approved'],
  properties: {
    answer: {
      type: 'string',
      title: 'Final answer',
      description: 'Explain your decision.',
      minLength: 1,
    },
    approved: { type: 'boolean' },
    score: { type: 'integer', minimum: 1, maximum: 5 },
    decision: { type: 'string', enum: ['revise', 'publish'] },
  },
};

describe('human response fields', () => {
  it('keeps schema labels, constraints, choices and required fields', () => {
    expect(humanResponseFields(schema)).toEqual([
      { name: 'answer', type: 'string', required: true, schema: schema.properties.answer },
      { name: 'approved', type: 'boolean', required: true, schema: schema.properties.approved },
      { name: 'score', type: 'integer', required: false, schema: schema.properties.score },
      {
        name: 'decision',
        type: 'string',
        required: false,
        schema: schema.properties.decision,
        choices: ['revise', 'publish'],
      },
    ]);
  });

  it.each([
    true,
    { type: 'object' },
    { type: 'object', properties: { answer: { type: 'object' } } },
    { ...schema, allOf: [{ required: ['score'] }] },
    { ...schema, required: ['unlisted'] },
    { type: 'object', properties: { answer: { type: ['string', 'null'] } } },
    { type: 'object', properties: { answer: { type: 'string', enum: [false] } } },
    { type: 'object', properties: { answer: { $ref: '#/$defs/answer' } } },
  ])('keeps unsupported schemas in the raw editor: %j', (value) => {
    expect(humanResponseFields(value)).toBeNull();
  });

  it('does not translate incompatible saved values into misleading form fields', () => {
    const fields = humanResponseFields(schema)!;
    expect(humanResponseFitsFields({}, fields)).toBe(true);
    expect(humanResponseFitsFields({ approved: false, score: 3 }, fields)).toBe(true);
    expect(humanResponseFitsFields({ answer: { nested: true } }, fields)).toBe(false);
    expect(humanResponseFitsFields({ approved: 'false' }, fields)).toBe(false);
    expect(humanResponseFitsFields({ score: 2.5 }, fields)).toBe(true);
    expect(humanResponseFitsFields({ decision: 'unknown' }, fields)).toBe(false);
  });

  it.each([
    ['boolean', true],
    ['boolean', false],
    ['string', 'approve'],
    ['number', 1.5],
    ['integer', 2],
  ])('offers an explicit choice for a %s constant', (type, value) => {
    const property = { type, const: value };
    expect(
      humanResponseFields({
        type: 'object',
        required: ['answer'],
        properties: { answer: property },
      }),
    ).toEqual([{ name: 'answer', type, required: true, schema: property, choices: [value] }]);
  });

  it.each([
    ['boolean', null],
    ['boolean', 'true'],
    ['string', false],
    ['integer', 1.5],
    ['number', { nested: 1 }],
    ['string', ['approve']],
  ])('keeps an incompatible %s constant in the raw editor', (type, value) => {
    expect(
      humanResponseFields({ type: 'object', properties: { answer: { type, const: value } } }),
    ).toBeNull();
  });

  it('edits one field without dropping unknown properties or false answers', () => {
    const draft = '{"answer":"Original","approved":false,"extra":{"keep":[1,2]}}';
    expect(JSON.parse(updateHumanResponse(draft, 'answer', 'Edited'))).toEqual({
      answer: 'Edited',
      approved: false,
      extra: { keep: [1, 2] },
    });
    expect(JSON.parse(updateHumanResponse(draft, 'approved', undefined))).toEqual({
      answer: 'Original',
      extra: { keep: [1, 2] },
    });
    expect(JSON.parse(updateHumanResponse('{}', '__proto__', 'kept'))).toEqual({
      ['__proto__']: 'kept',
    });
  });

  it.each(['{unfinished', '[]', 'null', 'false', '"text"'])(
    'keeps raw drafts unchanged: %s',
    (draft) => {
      expect(parseHumanResponse(draft)).toBeNull();
      expect(updateHumanResponse(draft, 'answer', 'Edited')).toBe(draft);
    },
  );
});
