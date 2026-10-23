// Tests for the ordered decrypt-and-apply pipeline (public/js/pipeline.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline } from '../../public/js/pipeline.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pipeline keeps order', async () => {
  const applied = [];
  let onApplied = 0;
  const p = createPipeline({
    decrypt: async (ev) => { if (ev.seq === 5) await sleep(50); return { s: ev.seq }; },
    apply: (ev, payload) => applied.push([ev.seq, payload.s]),
    reset: () => {},
    onApplied: () => { onApplied++; },
  });
  const a = p.push([{ seq: 5 }]);
  const b = p.push([{ seq: 6 }]);
  await Promise.all([a, b]);
  assert.deepEqual(applied, [[5, 5], [6, 6]]);
  assert.equal(onApplied, 2);
});

test('pipeline reset', async () => {
  const log = [];
  const p = createPipeline({
    decrypt: async (ev) => { if (ev.seq === 1) await sleep(30); return null; },
    apply: (ev) => log.push('apply' + ev.seq),
    reset: () => log.push('reset'),
    onApplied: () => log.push('done'),
  });
  p.push([{ seq: 1 }]);
  await p.push([{ seq: 2 }, { seq: 3 }], { reset: true });
  assert.deepEqual(log, ['apply1', 'done', 'reset', 'apply2', 'apply3', 'done']);
});

test('decrypt throw becomes null; errors do not break the chain', async () => {
  const got = [];
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a);
  try {
    let boom = true;
    const p = createPipeline({
      decrypt: async (ev) => { if (ev.seq === 1) throw new Error('x'); return 'ok'; },
      apply: (ev, payload) => { got.push([ev.seq, payload]); if (ev.seq === 2) throw new Error('apply'); },
      reset: () => {},
      onApplied: () => { if (boom) { boom = false; throw new Error('render'); } },
    });
    await p.push([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    await p.push([{ seq: 4 }]);
    assert.deepEqual(got, [[1, null], [2, 'ok'], [3, 'ok'], [4, 'ok']]);
    assert.equal(errs.length, 2);
  } finally { console.error = orig; }
});
