// node --test tools/test_labeltext.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTokens, rankByTokens } from '../app/js/labeltext.js';

test('model-like words are kept; dates, years, units and counts are not', () => {
  assert.deepEqual(modelTokens('MODEL NO. AT1323  120V~ 60Hz 1500W  MFG DATE 2023/05'), ['AT1323']);
  assert.deepEqual(modelTokens('Lot 092021 made 112022, 4-digit code, 2024, 52-inch'), []);
  assert.deepEqual(modelTokens('model KT-CS17 and LY-31, item 63456'), ['KTCS17', 'LY31', '63456']);
});

test('a label word finds the notice that names it, dashes ignored', () => {
  const cards = [
    { rid: '1', title: 'Heaters', ident: 'tower models AT1323, AT1481 and AT1520' },
    { rid: '2', title: 'Playsets', ident: 'model numbers KT-CS17 and LY-31' },
  ];
  assert.equal(rankByTokens(['KTCS17'], cards)[0].card.rid, '2');
  assert.equal(rankByTokens(['AT1481B'], cards)[0].card.rid, '1'); // suffix on the label
  assert.deepEqual(rankByTokens(['ZZ9999'], cards), []);
});
