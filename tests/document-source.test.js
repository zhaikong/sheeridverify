import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectDocumentSource } from '../src/apps/sheerid/document.js';

test('standalone material URLs work without personal data', () => {
  const url = 'https://school.example/original.png?page=2&name=Existing';
  assert.deepEqual(selectDocumentSource({ url }), { url });
});

test('local material paths do not need names', () => {
  const data = { firstName: 'Test' };
  assert.deepEqual(selectDocumentSource({ path: 'original.pdf' }, {}, data), { path: 'original.pdf' });
  assert.deepEqual(selectDocumentSource({ url: 'https://school.example/original.png' },
    { file: 'override.pdf' }, data), { path: 'override.pdf' });
});

test('partial or invalid names stop named downloads before requesting a file', () => {
  for (const data of [{ firstName: 'Test' }, { lastName: 'Student' }, { firstName: '', lastName: 'Student' },
    { firstName: 'Test', lastName: 123 }]) {
    assert.throws(() => selectDocumentSource({ url: 'https://school.example/original.png' }, {}, data),
      { code: 'INVALID_CONFIG' });
  }
});
