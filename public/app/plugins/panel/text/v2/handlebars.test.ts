import { initTemplateSrv } from 'test/helpers/initTemplateSrv';

import { FieldType, type InterpolateFunction, toDataFrame } from '@grafana/data';

import { buildAllRowsContext, buildRows, compileTemplate, type TemplateContext } from './handlebars';

const hosts = toDataFrame({
  name: 'frameA',
  refId: 'A',
  fields: [
    { name: 'host', type: FieldType.string, values: ['web-1', 'web-2'] },
    { name: 'cpu', type: FieldType.number, values: [0.84, 0.12] },
  ],
});

const empty = toDataFrame({
  name: 'frameB',
  refId: 'B',
  fields: [{ name: 'host', type: FieldType.string, values: [] }],
});

function createReplaceVariables(variables: unknown[] = []): InterpolateFunction {
  const templateSrv = initTemplateSrv('hello', variables);
  return (target, scopedVars, format) => templateSrv.replace(target, scopedVars, format);
}

function render(content: string, context: TemplateContext = {}, replaceVariables = createReplaceVariables()) {
  return compileTemplate(content, replaceVariables)(context);
}

/** A frame whose display processor adds a unit, as applyFieldOverrides would. */
function withUnit() {
  const frame = toDataFrame({
    fields: [{ name: 'cpu', type: FieldType.number, values: [0.84, 0.12], config: { unit: 'percentunit' } }],
  });
  frame.fields[0].display = (value) => ({ text: String(Number(value) * 100), numeric: Number(value), suffix: '%' });

  return frame;
}

describe('buildRows', () => {
  it('builds one plain object per row, keyed by field name', () => {
    const rows = buildRows(hosts, [hosts]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ host: 'web-1', cpu: 0.84 });
    expect(rows[0].fmt).toMatchObject({ host: 'web-1', cpu: '0.84' });
    expect(rows[1]).toMatchObject({ host: 'web-2', cpu: 0.12 });
    expect(rows[1].fmt).toMatchObject({ host: 'web-2', cpu: '0.12' });
  });

  it('keeps unit fields raw, with the formatted value under `fmt`', () => {
    const frame = withUnit();

    const rows = buildRows(frame, [frame]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ cpu: 0.84 });
    expect(rows[0].fmt).toMatchObject({ cpu: '84%' });
    expect(rows[1]).toMatchObject({ cpu: 0.12 });
    expect(rows[1].fmt).toMatchObject({ cpu: '12%' });
  });

  it('lets a field named `fmt` shadow the namespace rather than being hidden by it', () => {
    const frame = toDataFrame({ fields: [{ name: 'fmt', type: FieldType.string, values: ['mine'] }] });

    expect(buildRows(frame, [frame])).toEqual([{ fmt: 'mine' }]);
  });

  it('returns an empty array for a frame with no rows', () => {
    expect(buildRows(empty, [empty])).toEqual([]);
  });

  it('builds at most maxRows rows', () => {
    const rows = buildRows(hosts, [hosts], 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: 'web-1', cpu: 0.84 });
    expect(rows[0].fmt).toMatchObject({ host: 'web-1', cpu: '0.84' });
    expect(buildRows(hosts, [hosts], 0)).toEqual([]);
    expect(buildRows(hosts, [hosts], -1)).toEqual([]);
  });

  describe('lazy formatting', () => {
    it('does not invoke field.display when fmt is not accessed', () => {
      const displayMock = jest.fn((value) => ({ text: String(value), numeric: Number(value) }));
      const frame = toDataFrame({
        fields: [
          { name: 'host', type: FieldType.string, values: ['web-1', 'web-2'] },
          { name: 'cpu', type: FieldType.number, values: [0.84, 0.12] },
        ],
      });
      frame.fields[1].display = displayMock;

      const rows = buildRows(frame, [frame]);

      expect(displayMock).not.toHaveBeenCalled();

      const rawValue = rows[0].cpu;
      expect(rawValue).toBe(0.84);
      expect(displayMock).not.toHaveBeenCalled();
    });

    it('invokes field.display for all fields on first fmt access', () => {
      const displayCpuMock = jest.fn((value) => ({ text: String(value), numeric: Number(value) }));
      const displayMemMock = jest.fn((value) => ({ text: String(value), numeric: Number(value) }));
      const frame = toDataFrame({
        fields: [
          { name: 'cpu', type: FieldType.number, values: [0.84, 0.12] },
          { name: 'mem', type: FieldType.number, values: [0.65, 0.45] },
        ],
      });
      frame.fields[0].display = displayCpuMock;
      frame.fields[1].display = displayMemMock;

      const rows = buildRows(frame, [frame]);

      expect(displayCpuMock).not.toHaveBeenCalled();
      expect(displayMemMock).not.toHaveBeenCalled();

      const cpuFormatted = (rows[0].fmt as Record<string, unknown>).cpu;
      expect(cpuFormatted).toBe('0.84');
      expect(displayCpuMock).toHaveBeenCalledTimes(1);
      expect(displayMemMock).toHaveBeenCalledTimes(1);
    });

    it('caches formatted values for repeated access', () => {
      const displayMock = jest.fn((value) => ({ text: String(value), numeric: Number(value) }));
      const frame = toDataFrame({
        fields: [{ name: 'cpu', type: FieldType.number, values: [0.84] }],
      });
      frame.fields[0].display = displayMock;

      const rows = buildRows(frame, [frame]);
      const firstAccess = (rows[0].fmt as Record<string, unknown>).cpu;
      const secondAccess = (rows[0].fmt as Record<string, unknown>).cpu;

      expect(firstAccess).toBe(secondAccess);
      expect(displayMock).toHaveBeenCalledTimes(1);
    });

    it('lazily formats all fields when fmt is first accessed', () => {
      const displayMock = jest.fn((value) => ({ text: String(value), numeric: Number(value) }));
      const frame = toDataFrame({
        fields: [{ name: 'cpu', type: FieldType.number, values: [0.84] }],
      });
      frame.fields[0].display = displayMock;

      const rows = buildRows(frame, [frame]);
      const row = rows[0];

      expect(displayMock).not.toHaveBeenCalled();

      const fmt = row.fmt as Record<string, unknown>;
      expect(displayMock).toHaveBeenCalledTimes(1);

      const value = fmt.cpu;
      expect(value).toBe('0.84');
      expect(displayMock).toHaveBeenCalledTimes(1);

      const secondAccess = fmt.cpu;
      expect(secondAccess).toBe('0.84');
      expect(displayMock).toHaveBeenCalledTimes(1);
    });

    it('preserves enumeration semantics for Object.keys', () => {
      const rows = buildRows(hosts, [hosts]);
      const fmt = rows[0].fmt as Record<string, unknown>;

      const keys = Object.keys(fmt).sort();
      expect(keys).toEqual(['cpu', 'host']);
    });
  });
});

describe('buildAllRowsContext', () => {
  it('exposes every frame, and the first one with rows as `data`', () => {
    const context = buildAllRowsContext([empty, hosts]);

    expect(context.data).toEqual(buildRows(hosts, [empty, hosts]));
    expect(context.frames).toEqual([
      { name: 'frameB', refId: 'B', data: [] },
      { name: 'frameA', refId: 'A', data: buildRows(hosts, [empty, hosts]) },
    ]);
  });

  it('leaves `data` empty when there is nothing to render', () => {
    expect(buildAllRowsContext([])).toEqual({ data: [], frames: [] });
  });

  it('spends maxRows across the frames rather than per frame', () => {
    const context = buildAllRowsContext([hosts, hosts], 3);

    expect(context.frames.map((frame) => frame.data.length)).toEqual([2, 1]);
  });
});

describe('buildRows benchmarks', () => {
  const benchmarkFrameSizes = [
    { fields: 5, rows: 1000 },
    { fields: 20, rows: 1000 },
    { fields: 100, rows: 1000 },
  ];

  function createBenchmarkFrame(fieldCount: number, rowCount: number) {
    const fields = Array.from({ length: fieldCount }, (_, i) => ({
      name: `field${i}`,
      type: FieldType.number,
      values: Array.from({ length: rowCount }, () => Math.random()),
      config: { unit: 'percentunit' },
    }));

    const frame = toDataFrame({ fields });
    frame.fields.forEach((field) => {
      field.display = (value) => ({
        text: String(Number(value) * 100),
        numeric: Number(value),
        suffix: '%',
      });
    });

    return frame;
  }

  function median(values: number[]): number {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  function measureRenderTime(
    template: string,
    frame: ReturnType<typeof createBenchmarkFrame>,
    iterations = 30,
    warmupIterations = 5
  ): { median: number; min: number; max: number; mean: number; stddev: number } {
    const replaceVariables = createReplaceVariables();

    for (let i = 0; i < warmupIterations; i++) {
      const context = buildAllRowsContext([frame]);
      compileTemplate(template, replaceVariables)(context);
    }

    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const context = buildAllRowsContext([frame]);
      compileTemplate(template, replaceVariables)(context);
      const end = performance.now();
      times.push(end - start);
    }

    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / times.length;
    const stddev = Math.sqrt(variance);

    return {
      median: median(times),
      min: Math.min(...times),
      max: Math.max(...times),
      mean,
      stddev,
    };
  }

  benchmarkFrameSizes.forEach(({ fields, rows }) => {
    describe(`${fields} fields, ${rows} rows`, () => {
      it('runs performance checks', () => {
        const frame = createBenchmarkFrame(fields, rows);

        const rawOnly = measureRenderTime('{{#each data}}{{field0}},{{/each}}', frame);
        expect(rawOnly.median).toBeLessThan(1000);

        const fmtOne = measureRenderTime('{{#each data}}{{fmt.field0}},{{/each}}', frame);
        expect(fmtOne.median).toBeLessThan(1000);

        const fieldRefs = Array.from({ length: fields }, (_, i) => `{{fmt.field${i}}}`).join(',');
        const fmtAll = measureRenderTime(`{{#each data}}${fieldRefs},{{/each}}`, frame);
        expect(fmtAll.median).toBeLessThan(2000);
      });
    });
  });

  it('reports benchmark results', () => {
    const fs = require('fs');
    const results: Array<{ scenario: string; fields: number; stats: ReturnType<typeof measureRenderTime> }> = [];

    benchmarkFrameSizes.forEach(({ fields, rows }) => {
      const frame = createBenchmarkFrame(fields, rows);

      results.push({
        scenario: 'raw values only',
        fields,
        stats: measureRenderTime('{{#each data}}{{field0}},{{/each}}', frame),
      });

      results.push({
        scenario: 'fmt one field',
        fields,
        stats: measureRenderTime('{{#each data}}{{fmt.field0}},{{/each}}', frame),
      });

      const allFieldsTemplate = Array.from({ length: fields }, (_, i) => `{{fmt.field${i}}}`).join(',');
      results.push({
        scenario: 'fmt all fields',
        fields,
        stats: measureRenderTime(`{{#each data}}${allFieldsTemplate},{{/each}}`, frame),
      });
    });

    const output = [
      '\nBenchmark results (median±stddev ms, 1000 rows, 30 iterations after 5 warmup):',
      'Scenario               | 5 fields      | 20 fields     | 100 fields    ',
      '-----------------------|---------------|---------------|---------------',
    ];

    const scenarios = ['raw values only', 'fmt one field', 'fmt all fields'];
    scenarios.forEach((scenario) => {
      const values = benchmarkFrameSizes.map(({ fields }) => {
        const result = results.find((r) => r.scenario === scenario && r.fields === fields);
        return result ? `${result.stats.median.toFixed(1)}±${result.stats.stddev.toFixed(1)}` : 'N/A';
      });
      output.push(
        `${scenario.padEnd(22)} | ${values[0].padStart(13)} | ${values[1].padStart(13)} | ${values[2].padStart(13)}`
      );
    });

    fs.writeFileSync('/tmp/benchmark-results.txt', output.join('\n'));
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('compileTemplate', () => {
  it('leaves content without expressions untouched', () => {
    expect(render('# Title')).toBe('# Title');
  });

  it('resolves an expression against the context', () => {
    expect(render('{{host}}', { host: 'web-1' })).toBe('web-1');
  });

  it('iterates rows', () => {
    expect(render('{{#each data}}{{host}},{{/each}}', buildAllRowsContext([hosts]))).toBe('web-1,web-2,');
  });

  it('HTML-escapes by default, and does not for triple braces', () => {
    expect(render('{{host}}', { host: '<b>x</b>' })).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(render('{{{host}}}', { host: '<b>x</b>' })).toBe('<b>x</b>');
  });

  describe('helpers', () => {
    it.each([
      ['and true', '{{#if (and a b)}}y{{/if}}', { a: true, b: true }, 'y'],
      ['and false', '{{#if (and a b)}}y{{/if}}', { a: true, b: false }, ''],
      ['and reads every argument', '{{#if (and a b c)}}y{{/if}}', { a: true, b: true, c: false }, ''],
      ['or', '{{#if (or a b)}}y{{/if}}', { a: false, b: true }, 'y'],
      ['or reads every argument', '{{#if (or a b c)}}y{{/if}}', { a: false, b: false, c: true }, 'y'],
      ['not', '{{#if (not a)}}y{{/if}}', { a: false }, 'y'],
      ['eq', '{{#if (eq a "x")}}y{{/if}}', { a: 'x' }, 'y'],
      ['unlessEq', '{{#if (unlessEq a "x")}}y{{/if}}', { a: 'z' }, 'y'],
      ['gt', '{{#if (gt a 2)}}y{{/if}}', { a: 3 }, 'y'],
      ['gte', '{{#if (gte a 3)}}y{{/if}}', { a: 3 }, 'y'],
      ['lt', '{{#if (lt a 2)}}y{{/if}}', { a: 1 }, 'y'],
      ['lte', '{{#if (lte a 1)}}y{{/if}}', { a: 1 }, 'y'],
      ['contains on an array', '{{#if (contains a "x")}}y{{/if}}', { a: ['x', 'z'] }, 'y'],
      ['contains on a string', '{{#if (contains a "ell")}}y{{/if}}', { a: 'hello' }, 'y'],
      ['startsWith', '{{#if (startsWith a "he")}}y{{/if}}', { a: 'hello' }, 'y'],
      ['endsWith', '{{#if (endsWith a "lo")}}y{{/if}}', { a: 'hello' }, 'y'],
      ['match', '{{#if (match a "^web-")}}y{{/if}}', { a: 'web-1' }, 'y'],
      ['split + join', '{{join (split a ",") "|"}}', { a: 'a,b' }, 'a|b'],
      ['split + join without separators', '{{join (split a)}}', { a: 'a,b' }, 'a,b'],
      ['toFixed', '{{toFixed a 2}}', { a: 1.234 }, '1.23'],
      ['toFixed without digits', '{{toFixed a}}', { a: 1.234 }, '1.234'],
      ['toFixed on a non-number', '{{toFixed a 2}}', { a: 'n/a' }, 'n/a'],
      ['json', '{{{json a}}}', { a: { b: 1 } }, '{\n  "b": 1\n}'],
    ])('%s', (_name, content, context, expected) => {
      expect(render(content, context)).toBe(expected);
    });

    // Handlebars counts an empty array and 0 as falsy, so `(and data …)` has to as well.
    it.each([
      ['an empty array', []],
      ['zero', 0],
    ])('agrees with `#if` on %s', (_name, value) => {
      const inIf = render('{{#if a}}y{{else}}n{{/if}}', { a: value });

      expect(render('{{#if (and a)}}y{{else}}n{{/if}}', { a: value })).toBe(inIf);
      expect(render('{{#if (or a)}}y{{else}}n{{/if}}', { a: value })).toBe(inIf);
      expect(render('{{#if (not a)}}y{{else}}n{{/if}}', { a: value })).toBe('y');
    });

    it('compares unit fields, and prints them formatted through `fmt`', () => {
      const frame = withUnit();
      const context = buildAllRowsContext([frame]);

      expect(render('{{#each data}}{{#if (gt cpu 0.5)}}[{{fmt.cpu}}]{{/if}}{{/each}}', context)).toBe('[84%]');
    });

    it('formats dates', () => {
      expect(render('{{date a "YYYY-MM-DD"}}', { a: '2026-08-11T10:00:00Z' })).toBe('2026-08-11');
    });

    it('renders now for `date` with no argument, and nothing for a value that is not a date', () => {
      expect(render('{{date}}')).not.toBe('');
      expect(render('{{date a}}', { a: null })).toBe('');
      expect(render('{{date a}}', { a: '' })).toBe('');
      expect(render('{{date missing}}')).toBe('');
    });

    it('reads a dashboard variable as a value and as a list', () => {
      const replaceVariables = createReplaceVariables([
        {
          type: 'custom',
          name: 'env',
          current: { value: ['dev', 'prod'], text: ['dev', 'prod'] },
          options: [
            { value: 'dev', text: 'dev', selected: true },
            { value: 'prod', text: 'prod', selected: true },
          ],
          multi: true,
        },
      ]);

      expect(render('{{#each (variable "env")}}[{{this}}]{{/each}}', {}, replaceVariables)).toBe('[dev][prod]');
      expect(render('{{variableValue "env"}}', {}, replaceVariables)).toBe('{dev,prod}');
    });
  });

  describe('errors', () => {
    it('throws on a syntax error, at compile time', () => {
      expect(() => compileTemplate('{{#if a}}no close', createReplaceVariables())).toThrow();
    });

    it('throws on a runtime error', () => {
      expect(() => render('{{nope a}}', { a: 1 })).toThrow();
    });
  });
});
