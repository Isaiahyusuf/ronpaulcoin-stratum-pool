const test = require('node:test');
const assert = require('node:assert/strict');
const { scryptHash } = require('../lib/scryptHash');
const { vectors } = require('./fixtures/daemon-scrypt-vectors.json');

test('matches the daemon unit-test vectors (displayed hash is the byte-reversed digest)', () => {
    for (const { header, powHash } of vectors) {
        const digest = scryptHash(Buffer.from(header, 'hex'));
        assert.equal(Buffer.from(digest).reverse().toString('hex'), powHash);
    }
});

test('rejects headers that are not exactly 80 bytes', () => {
    assert.throws(() => scryptHash(Buffer.alloc(79)), TypeError);
    assert.throws(() => scryptHash('00'.repeat(80)), TypeError);
});
