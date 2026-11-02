// node --test tests/exportar.test.mjs — inyección CSV y formato para Excel en español.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aCsv } from '../apps/web/src/core/exportar.ts';

test('neutraliza fórmulas y respeta ; y comillas', () => {
  const csv = aCsv([{ a: '=HYPERLINK("x")', b: 1.5, c: 'x;y', d: -2, e: '@SUM(A1)' }]);
  const [cab, fila] = csv.split('\r\n');
  assert.equal(cab, 'a;b;c;d;e');
  assert.equal(fila, `"'=HYPERLINK(""x"")";1,5;"x;y";-2;'@SUM(A1)`);
});
