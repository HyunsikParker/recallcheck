// node --test tools/test_upc.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDigit, isValidGtin, normaliseScanned, expandUpcE, extractUpcs } from '../app/js/upc.js';

test('check digit and validity', () => {
  assert.equal(checkDigit('03600029145'), '2');
  assert.ok(isValidGtin('036000291452'));
  assert.ok(!isValidGtin('036000291453'));
  assert.ok(isValidGtin('4006381333931')); // EAN-13
});

test('scanned codes normalise to one GTIN-14', () => {
  assert.equal(normaliseScanned('0 36000 29145 2'), '00036000291452');
  assert.equal(normaliseScanned('0036000291452'), '00036000291452'); // EAN-13 spelling of the same UPC-A
  assert.equal(normaliseScanned('03600029145'), '00036000291452'); // check digit missing
  assert.equal(normaliseScanned('12345'), null);
});

test('UPC-E expands to UPC-A', () => {
  assert.equal(expandUpcE('04252614'), '042100005264');
  assert.equal(normaliseScanned('04252614', 'upc_e'), '00042100005264');
  assert.equal(normaliseScanned('96385074', 'ean_8'), '00000096385074');
});

test('UPCs are pulled out of recall text and lot codes are not', () => {
  const got = extractUpcs('Iceberg Salad 12 oz, UPC 6-81131-32894-4; Lot TFMX181A03 7/19/2026').map((u) => u.gtin14);
  assert.deepEqual(got, ['00681131328944']);
  const spaced = extractUpcs('5 lbs., UPC 0 41449 47540 0. Lot code KX2062').map((u) => u.gtin14);
  assert.deepEqual(spaced, ['00041449475400']);
  assert.deepEqual(extractUpcs('No UPC on label. Best by 01/22/25'), []);
});
