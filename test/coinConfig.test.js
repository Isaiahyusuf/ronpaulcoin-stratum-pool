const test = require('node:test');
const assert = require('node:assert/strict');

require('../vendor/stratum-pool/lib');
const coin = require('../coins/ronpaulcoin.json');

test('coin selects the scrypt algorithm implemented by the pool', () => {
    assert.equal(coin.algorithm, 'scrypt');
    assert.equal(typeof global.algos[coin.algorithm].hash, 'function');
});

test('daemon only offers getinfo, so the pool must not call getblockchaininfo', () => {
    assert.equal(coin.hasGetInfo, true);
});

test('peer magic values are 4-byte hex strings and differ between networks', () => {
    for (const magic of [coin.peerMagic, coin.peerMagicTestnet]) {
        assert.match(magic, /^[0-9a-f]{8}$/);
    }
    assert.notEqual(coin.peerMagic, coin.peerMagicTestnet);
});

test('coin does not force a reward type, so the pool detects proof-of-work from the daemon', () => {
    assert.equal(coin.reward, undefined);
});
