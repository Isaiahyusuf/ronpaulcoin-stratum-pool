const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeAddress, decodeAddress, classifyAddress } = require('../lib/address');
const coin = require('../coins/ronpaulcoin.json');

const hash160 = Buffer.from('77bff20c60e522dfaa3350c39b030a5d004e839a', 'hex');

test('decodes a known Bitcoin address with its checksum', () => {
    const decoded = decodeAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2');
    assert.equal(decoded.version, 0);
    assert.deepEqual(decoded.hash160, hash160);
});

test('mainnet pubkey hash addresses start with R', () => {
    const address = encodeAddress(coin.addressVersions.mainnet.pubkeyHash, hash160);
    assert.match(address, /^R/);
    assert.deepEqual(decodeAddress(address).hash160, hash160);
});

test('rejects an address with a corrupted checksum', () => {
    const address = encodeAddress(60, hash160);
    const last = address.slice(-1) === '2' ? '3' : '2';
    assert.equal(decodeAddress(address.slice(0, -1) + last), null);
});

test('rejects wrong length, bad characters and non-strings', () => {
    assert.equal(decodeAddress('R'), null);
    assert.equal(decodeAddress('0OIl'), null);
    assert.equal(decodeAddress(undefined), null);
    assert.equal(decodeAddress(''), null);
});

test('classifyAddress accepts only the versions of the selected network', () => {
    const { mainnet, testnet } = coin.addressVersions;
    const main = encodeAddress(mainnet.pubkeyHash, hash160);
    const mainScript = encodeAddress(mainnet.scriptHash, hash160);
    assert.equal(classifyAddress(main, mainnet).type, 'pubkeyHash');
    assert.equal(classifyAddress(mainScript, mainnet).type, 'scriptHash');
    assert.equal(classifyAddress(main, testnet), null);
    assert.equal(classifyAddress(encodeAddress(0, hash160), mainnet), null);
});
