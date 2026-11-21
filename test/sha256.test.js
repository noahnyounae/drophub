import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const Sha256 = createRequire(import.meta.url)('../public/static/sha256.js');

test('incremental SHA-256 matches node:crypto', () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
    const data = crypto.randomBytes(size);
    const h = new Sha256();
    for (let i = 0; i < size; i += 37) h.update(data.subarray(i, Math.min(size, i + 37)));
    assert.equal(h.hex(), crypto.createHash('sha256').update(data).digest('hex'), `size ${size}`);
  }
});
