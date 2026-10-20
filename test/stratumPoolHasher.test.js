const test = require('node:test');
const assert = require('node:assert/strict');
const bignum = require('../lib/bignum');

require('../vendor/stratum-pool/lib');
const { vectors } = require('./fixtures/daemon-scrypt-vectors.json');

const hashDigest = global.algos.scrypt.hash({});

test('upstream scrypt entry returns the raw 32-byte digest for 80-byte headers', () => {
    for (const { header } of vectors) {
        const digest = hashDigest(Buffer.from(header, 'hex'), 0);
        assert.ok(Buffer.isBuffer(digest));
        assert.equal(digest.length, 32);
    }
});

test('digest read as little-endian by jobManager equals the daemon PoW hash', () => {
    for (const { header, powHash } of vectors) {
        const digest = hashDigest(Buffer.from(header, 'hex'), 0);
        const asNumber = bignum.fromBuffer(digest, { endian: 'little', size: 32 });
        assert.equal(asNumber.toString(16).padStart(64, '0'), powHash);
    }
});

test('scrypt keeps the upstream share multiplier of 2^16', () => {
    assert.equal(global.algos.scrypt.multiplier, 65536);
});

test('non-RonPaulCoin scrypt parameters are rejected instead of hashed incorrectly', () => {
    const header = Buffer.from(vectors[0].header, 'hex');
    assert.throws(() => global.algos.scrypt.hash({ nValue: 64 })(header, 0), RangeError);
    assert.throws(() => global.algos.scrypt.hash({ rValue: 2 })(header, 0), RangeError);
});
