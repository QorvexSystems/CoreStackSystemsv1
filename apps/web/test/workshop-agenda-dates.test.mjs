import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../components/operations/workshop-agenda-view.tsx', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function localDateTime('), source.indexOf('function adminDateLabel('));
const context = vm.createContext({ Date });
vm.runInContext(ts.transpile(functions, { target: ts.ScriptTarget.ES2022 }), context);

test('agenda preserves Sunday and Monday in the Dominican timezone', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Santo_Domingo';
  try {
    for (const day of ['2026-11-08', '2026-11-09', '2026-11-01']) {
      const range = context.getAppointmentRange(day, 'DAY');
      assert.equal(range.from, `${day}T04:00:00.000Z`);
      for (const time of ['00:00:00', '12:00:00', '23:59:59']) {
        const date = new Date(`${day}T${time}-04:00`);
        assert.ok(date >= new Date(range.from) && date <= new Date(range.to));
      }
    }
    const week = context.getAppointmentRange('2026-11-01', 'WEEK');
    assert.equal(week.from, '2026-10-26T04:00:00.000Z');
    assert.equal(week.to, '2026-11-02T03:59:59.999Z');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
