// Test-only transaction builder: a deterministic secp256k1 key and legacy
// pay-to-pubkey-hash signing, used to spend pool coinbase outputs on regtest.
const crypto = require('node:crypto');
const { sha256d } = require('./testMiner');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const hash160 = (data) => crypto.createHash('ripemd160').update(sha256(data)).digest();
const SIGHASH_ALL = 1;

function varInt(value) {
    if (value < 0xfd) return Buffer.from([value]);
    const out = Buffer.alloc(3);
    out[0] = 0xfd;
    out.writeUInt16LE(value, 1);
    return out;
}

const pushData = (data) => Buffer.concat([Buffer.from([data.length]), data]);
const p2pkhScript = (keyHash) => Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), keyHash, Buffer.from([0x88, 0xac])]);

function createTestKey(label) {
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(sha256(label));
    const uncompressed = ecdh.getPublicKey();
    const privateKey = crypto.createPrivateKey({
        key: {
            kty: 'EC',
            crv: 'secp256k1',
            d: ecdh.getPrivateKey().toString('base64url'),
            x: uncompressed.subarray(1, 33).toString('base64url'),
            y: uncompressed.subarray(33).toString('base64url')
        },
        format: 'jwk'
    });
    const publicKey = ecdh.getPublicKey(null, 'compressed');
    const keyHash = hash160(publicKey);
    return { privateKey, publicKey, hash160: keyHash, script: p2pkhScript(keyHash) };
}

function serialize({ inputs, outputs }) {
    const version = Buffer.alloc(4);
    version.writeInt32LE(1);
    const lockTime = Buffer.alloc(4);
    const parts = [version, varInt(inputs.length)];
    for (const input of inputs) {
        const index = Buffer.alloc(4);
        index.writeUInt32LE(input.index);
        const sequence = Buffer.alloc(4);
        sequence.writeUInt32LE(0xffffffff);
        parts.push(input.txid, index, varInt(input.scriptSig.length), input.scriptSig, sequence);
    }
    parts.push(varInt(outputs.length));
    for (const output of outputs) {
        const value = Buffer.alloc(8);
        value.writeBigUInt64LE(output.value);
        parts.push(value, varInt(output.script.length), output.script);
    }
    parts.push(lockTime);
    return Buffer.concat(parts);
}

// spends is a list of { txid (internal byte order), index }, all locked to key.script.
function buildSignedTransaction(key, spends, outputs) {
    const unsigned = { inputs: spends.map((spend) => ({ ...spend, scriptSig: Buffer.alloc(0) })), outputs };
    const inputs = spends.map((spend, position) => {
        const forSigning = {
            inputs: unsigned.inputs.map((input, i) => ({ ...input, scriptSig: i === position ? key.script : Buffer.alloc(0) })),
            outputs
        };
        const hashType = Buffer.alloc(4);
        hashType.writeUInt32LE(SIGHASH_ALL);
        const preimage = Buffer.concat([serialize(forSigning), hashType]);
        // Sign hashes its input once more, so feeding it sha256(preimage) signs sha256d(preimage).
        const signature = crypto.createSign('sha256').update(sha256(preimage)).sign(key.privateKey);
        const scriptSig = Buffer.concat([pushData(Buffer.concat([signature, Buffer.from([SIGHASH_ALL])])), pushData(key.publicKey)]);
        return { ...spend, scriptSig };
    });
    const raw = serialize({ inputs, outputs });
    const txid = sha256d(raw);
    return { raw, hex: raw.toString('hex'), txid, id: Buffer.from(txid).reverse().toString('hex') };
}

module.exports = { createTestKey, buildSignedTransaction, p2pkhScript };
