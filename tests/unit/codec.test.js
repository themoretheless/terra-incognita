import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRLE, decodeRLE, fnv1a, popcount, bytesToBase64, base64ToBytes } from '../../src/codec.js';

test('RLE: пустой, полный и смешанный чанк восстанавливаются без потерь', () => {
  const empty = new Uint8Array(8192);
  const full = new Uint8Array(8192).fill(0xff);
  const mixed = new Uint8Array(8192);
  for (let i = 0; i < mixed.length; i += 97) mixed[i] = (i * 31) & 0xff;
  mixed.fill(0xff, 4000, 4100);
  for (const bytes of [empty, full, mixed]) {
    const encoded = encodeRLE(bytes);
    assert.deepEqual(decodeRLE(encoded, bytes.length), bytes);
  }
  assert.equal(encodeRLE(empty).length, 3);
  assert.equal(encodeRLE(full).length, 3);
  assert.ok(encodeRLE(mixed).length < mixed.length);
});

test('RLE: битые данные дают ошибку', () => {
  assert.throws(() => decodeRLE(Uint8Array.from([0, 0xff, 0xff]), 8192), /длиннее/);
  assert.throws(() => decodeRLE(Uint8Array.from([0, 10, 0]), 8192), /короче/);
  assert.throws(() => decodeRLE(Uint8Array.from([7, 1, 0]), 1), /тег/);
});

test('fnv1a детерминирован и различает данные', () => {
  assert.equal(fnv1a(['abc']), fnv1a(['abc']));
  assert.notEqual(fnv1a(['abc']), fnv1a(['abd']));
  assert.equal(fnv1a([Uint8Array.from([1, 2, 3])]).length, 8);
});

test('popcount и base64', () => {
  assert.equal(popcount(Uint8Array.from([0xff, 0x01, 0x80])), 10);
  const bytes = Uint8Array.from([0, 1, 254, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});
