const test = require('node:test');
const assert = require('node:assert/strict');
const bignum = require('../lib/bignum');
const base58 = require('../lib/base58');

test('bignum reads buffers in both byte orders', () => {
    const buffer = Buffer.from('0102', 'hex');
    assert.equal(bignum.fromBuffer(buffer).toNumber(), 0x0102);
    assert.equal(bignum.fromBuffer(buffer, { endian: 'little', size: 2 }).toNumber(), 0x0201);
    assert.equal(bignum.fromBuffer(Buffer.alloc(0)).toNumber(), 0);
});

test('bignum expands compact bits to the expected target', () => {
    const bits = Buffer.from('1d00ffff', 'hex');
    const target = bignum.fromBuffer(bits.subarray(1)).mul(bignum(2).pow(bignum(8).mul(bits[0] - 3)));
    assert.equal(target.toString(16), 'ffff'.padEnd(56, '0'));
    assert.equal(target.toBuffer().toString('hex'), 'ffff'.padEnd(56, '0'));
});

test('bignum comparison and conversion', () => {
    assert.ok(bignum(10).ge(bignum(10)));
    assert.ok(!bignum(9).ge(10));
    assert.equal(bignum(0).toBuffer().toString('hex'), '00');
    assert.equal(bignum('00ff', 16).toNumber(), 255);
});

test('bignum rejects invalid operands instead of coercing them', () => {
    assert.throws(() => bignum('zz', 16), SyntaxError);
    assert.throws(() => bignum('ff'), RangeError);
    assert.throws(() => bignum(2).pow(-1), RangeError);
    assert.throws(() => bignum(2).mul(1.5), TypeError);
    assert.throws(() => bignum(2).mul('3'), TypeError);
});

test('base58 matches the published address example', () => {
    const payload = Buffer.from('00010966776006953d5567439e5e39f86a0d273beed61967f6', 'hex');
    assert.equal(base58.encode(payload), '16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM');
    assert.deepEqual(base58.decode('16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM'), payload);
});

test('base58 preserves leading zero bytes and round-trips', () => {
    assert.equal(base58.encode(Buffer.alloc(21)), '1'.repeat(21));
    assert.deepEqual(base58.decode('1'.repeat(21)), Buffer.alloc(21));
    const buffer = Buffer.from('0000a1b2c3', 'hex');
    assert.deepEqual(base58.decode(base58.encode(buffer)), buffer);
});

test('base58 rejects characters outside the alphabet', () => {
    for (const text of ['0OIl', 'abc+', 'R 1']) {
        assert.throws(() => base58.decode(text), SyntaxError);
    }
});
