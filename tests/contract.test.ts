import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { base64, textBytes } from '../src/lib/bytes';
import { examples, RESEARCH_SOURCE } from '../src/lib/examples';
import { graphOrder, nodePorts } from '../src/lib/graph';
import {
  parsePipeline,
  validatePipeline,
  validateResponse,
  validPath,
} from '../src/lib/validation';

const fixture = (path: string) =>
  readFileSync(resolve('vendor/engine/contracts/v1/fixtures', path), 'utf8');
const errors = (source: string) =>
  validatePipeline(source).diagnostics.filter((d) => d.severity === 'error');

describe('repository contracts in the desktop workbench', () => {
  for (const example of examples)
    it(`opens the complete ${example.id} package without local errors`, () => {
      const result = validatePipeline(example.source, example.files, example.entrypoint);
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(result.pipeline).toBeDefined();
      expect(result.diagnostics.some((d) => d.code === 'ENGINE_ADMISSION_REQUIRED')).toBe(true);
    });

  it('rejects every fixture that the authoritative manifest marks structurally invalid', () => {
    const manifest = JSON.parse(fixture('manifest.json'));
    for (const entry of manifest.cases)
      if (entry.expected.structural === 'reject') {
        expect(errors(fixture(entry.document)), entry.id).toEqual(
          expect.arrayContaining([expect.objectContaining({ layer: 'structural' })]),
        );
      }
  });
  for (const [name, code] of [
    ['unresolved-node', 'REFERENCE_UNRESOLVED'],
    ['graph-cycle', 'GRAPH_CYCLE'],
    ['invalid-default-value', 'DEFAULT_INVALID'],
    ['scope-parent-node-in-body', 'REFERENCE_UNRESOLVED'],
    ['foreach-over-non-array', 'FOREACH_TYPE'],
    ['optional-foreach-export', 'FOREACH_EXPORT'],
    ['loop-reserved-export', 'LOOP_EXPORT'],
    ['loop-state-outside-loop', 'SCOPE_INVALID'],
  ])
    it(`diagnoses ${name}`, () => {
      expect(errors(fixture(`negative/${name}.yaml`))).toEqual(
        expect.arrayContaining([expect.objectContaining({ code, layer: 'semantic' })]),
      );
    });
  for (const source of [
    'a: 1\na: 2',
    'a: &x 1\nb: *x',
    'a: !custom value',
    'a: 1\n---\n',
    'a: 0x10',
    '%YAML 1.1\n---\na: on',
    'a: .inf',
    'a: 1e-9999',
  ])
    it(`rejects unsupported YAML ${source}`, () => {
      expect(errors(source).some((d) => d.layer === 'parse')).toBe(true);
    });

  it('requires supporting files and preserves imported output ports', () => {
    const llm = examples.find((e) => e.id === 'llm')!;
    expect(validatePipeline(llm.source).diagnostics.some((d) => d.code === 'FILE_MISSING')).toBe(
      true,
    );

    const sub = examples.find((e) => e.id === 'subpipeline')!;
    expect(
      validatePipeline(sub.source, sub.files).diagnostics.filter((d) => d.severity === 'error'),
    ).toEqual([]);
  });

  it('rejects folded path conflicts and traversal', () => {
    const files = ['A.txt', 'a.txt'].map((path) => ({
      path,
      content: base64(textBytes('contents')),
    }));

    expect(
      validatePipeline(RESEARCH_SOURCE, files).diagnostics.some((d) => d.code === 'PATH_INVALID'),
    ).toBe(true);
    for (const path of ['../x', '/x', 'a//x', 'a\\x', 'C:x', 'x\n', 'x/./y'])
      expect(validPath(path)).toBe(false);
  });

  it('builds dependencies without treating literal strings as graph references', () => {
    const p = parsePipeline(RESEARCH_SOURCE)!;
    expect(graphOrder(p.spec).cycle).toEqual([]);

    const order = graphOrder(p.spec).order;
    expect(order.indexOf('discover')).toBeLessThan(order.indexOf('research'));
    expect(order.indexOf('review')).toBeLessThan(order.indexOf('publish'));

    const switchP = parsePipeline(examples.find((e) => e.id === 'switch')!.source)!;
    expect(Object.keys(nodePorts(switchP.spec.nodes.choose))).toEqual(['route']);
  });

  it('validates human responses by their declared output ports', () => {
    const p = parsePipeline(RESEARCH_SOURCE)!;
    expect(validateResponse(p, 'review', { feedback: 'Reviewed.' })).toEqual([]);
    expect(validateResponse(p, 'review', {})).toContain('Missing required output: feedback');
    expect(validateResponse(p, 'review', { feedback: 10 }).length).toBeGreaterThan(0);
    expect(validateResponse(p, 'review', { feedback: 'yes', secret: 'extra' })).toContain(
      'Unknown output: secret',
    );
    expect(validateResponse(p, 'review', null).length).toBeGreaterThan(0);
  });
});
