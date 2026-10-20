const test = require('node:test');
const assert = require('node:assert/strict');

require('../vendor/stratum-pool/lib');
const util = require('../vendor/stratum-pool/lib/util');
const base58 = require('../lib/base58');

const MAINNET_P2PKH_VERSION = 60;
const keyHash = Buffer.from('77bff20c60e522dfaa3350c39b030a5d004e839a', 'hex');

function addressFor(version, hash) {
    const payload = Buffer.concat([Buffer.from([version]), hash]);
    return base58.encode(Buffer.concat([payload, util.sha256d(payload).subarray(0, 4)]));
}

test('mainnet pay-to-pubkey-hash addresses start with R and become P2PKH scripts', () => {
    const address = addressFor(MAINNET_P2PKH_VERSION, keyHash);
    assert.equal(address[0], 'R');
    const script = util.addressToScript(address);
    assert.equal(script.toString('hex'), `76a914${keyHash.toString('hex')}88ac`);
});

test('address version byte is read from the base58 payload', () => {
    assert.equal(util.getVersionByte(addressFor(MAINNET_P2PKH_VERSION, keyHash))[0], MAINNET_P2PKH_VERSION);
});

test('malformed addresses are rejected', () => {
    assert.throws(() => util.addressToScript('R0000notbase58'));
    assert.throws(() => util.addressToScript(addressFor(MAINNET_P2PKH_VERSION, keyHash).slice(1)));
});

test('compact bits convert to the daemon target for the regtest and mainnet limits', () => {
    assert.equal(util.bignumFromBitsHex('207fffff').toString(16), '7fffff'.padEnd(64, '0'));
    assert.equal(util.bignumFromBitsHex('1e0ffff0').toString(16), 'ffff0'.padEnd(59, '0'));
});
