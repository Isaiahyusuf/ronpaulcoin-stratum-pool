// Test-only miner helpers. They rebuild coinbase, merkle root and header from the
// Stratum notify parameters using the Bitcoin serialization rules, without using
// any code from vendor/stratum-pool, so the pool's own job construction is checked.
const crypto = require('node:crypto');
const { scryptHash } = require('../../lib/scryptHash');

const sha256d = (data) => {
    const sha256 = (input) => crypto.createHash('sha256').update(input).digest();
    return sha256(sha256(data));
};
const reverse = (buffer) => Buffer.from(buffer).reverse();

function swapWords(buffer) {
    const out = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length; i += 4) out.writeUInt32LE(buffer.readUInt32BE(i), i);
    return out;
}

function readVarInt(buffer, offset) {
    const first = buffer[offset];
    if (first < 0xfd) return { value: first, next: offset + 1 };
    if (first === 0xfd) return { value: buffer.readUInt16LE(offset + 1), next: offset + 3 };
    if (first === 0xfe) return { value: buffer.readUInt32LE(offset + 1), next: offset + 5 };
    return { value: Number(buffer.readBigUInt64LE(offset + 1)), next: offset + 9 };
}

function parseTransaction(buffer) {
    let offset = 0;
    const version = buffer.readInt32LE(offset);
    offset += 4;

    let count = readVarInt(buffer, offset);
    offset = count.next;
    const inputs = [];
    for (let i = 0; i < count.value; i++) {
        const previousTxid = buffer.subarray(offset, offset + 32);
        const previousIndex = buffer.readUInt32LE(offset + 32);
        const script = readVarInt(buffer, offset + 36);
        const scriptSig = buffer.subarray(script.next, script.next + script.value);
        offset = script.next + script.value;
        inputs.push({ previousTxid, previousIndex, scriptSig, sequence: buffer.readUInt32LE(offset) });
        offset += 4;
    }

    count = readVarInt(buffer, offset);
    offset = count.next;
    const outputs = [];
    for (let i = 0; i < count.value; i++) {
        const value = buffer.readBigUInt64LE(offset);
        const script = readVarInt(buffer, offset + 8);
        outputs.push({ value, script: buffer.subarray(script.next, script.next + script.value) });
        offset = script.next + script.value;
    }

    const lockTime = buffer.readUInt32LE(offset);
    offset += 4;
    return { version, inputs, outputs, lockTime, trailingBytes: buffer.length - offset };
}

// Equivalent of CScript() << height in the daemon's CreateNewBlock.
function heightPush(height) {
    if (height === 0) return Buffer.from([0x00]);
    if (height <= 16) return Buffer.from([0x50 + height]);
    const bytes = [];
    let remaining = height;
    while (remaining > 0) {
        bytes.push(remaining & 0xff);
        remaining >>= 8;
    }
    if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
    return Buffer.from([bytes.length, ...bytes]);
}

function p2pkhHash160(script) {
    const isP2pkh = script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14
        && script[23] === 0x88 && script[24] === 0xac;
    return isP2pkh ? script.subarray(3, 23) : null;
}

function merkleRootFromBranch(coinbaseTxid, branchHex) {
    return branchHex.reduce((hash, step) => sha256d(Buffer.concat([hash, Buffer.from(step, 'hex')])), coinbaseTxid);
}

function merkleRootFromList(txids) {
    let level = txids;
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            next.push(sha256d(Buffer.concat([level[i], level[i + 1] || level[i]])));
        }
        level = next;
    }
    return level[0];
}

function buildCandidate(notifyParams, extraNonce1Hex, extraNonce2Hex) {
    const [jobId, prevhash, coinbase1, coinbase2, branch, version, bits, ntime] = notifyParams;
    const coinbase = Buffer.concat([
        Buffer.from(coinbase1, 'hex'),
        Buffer.from(extraNonce1Hex, 'hex'),
        Buffer.from(extraNonce2Hex, 'hex'),
        Buffer.from(coinbase2, 'hex')
    ]);
    const coinbaseTxid = sha256d(coinbase);
    const merkleRoot = merkleRootFromBranch(coinbaseTxid, branch);
    const headerPrefix = Buffer.concat([
        reverse(Buffer.from(version, 'hex')),
        swapWords(Buffer.from(prevhash, 'hex')),
        merkleRoot,
        reverse(Buffer.from(ntime, 'hex')),
        reverse(Buffer.from(bits, 'hex'))
    ]);
    const headerFor = (nonce) => {
        const nonceBytes = Buffer.alloc(4);
        nonceBytes.writeUInt32LE(nonce);
        return Buffer.concat([headerPrefix, nonceBytes]);
    };
    return { jobId, coinbase, coinbaseTxid, merkleRoot, headerFor, ntime, extraNonce2: extraNonce2Hex };
}

function proofOfWork(header) {
    return BigInt(`0x${reverse(scryptHash(header)).toString('hex')}`);
}

const SCRYPT_DIFFICULTY_1_TARGET = 0xffffn << 224n;

function shareDifficulty(pow) {
    return Number((SCRYPT_DIFFICULTY_1_TARGET * 1_000_000_000n) / pow) / 1e9;
}

function targetFromBits(bitsHex) {
    const bits = Buffer.from(bitsHex, 'hex').readUInt32BE();
    const exponent = bits >>> 24;
    return BigInt(bits & 0x7fffff) << BigInt(8 * (exponent - 3));
}

const nonceHex = (nonce) => nonce.toString(16).padStart(8, '0');

function findNonce(candidate, accept, { start = 0, limit = 5_000_000 } = {}) {
    for (let nonce = start; nonce < start + limit; nonce++) {
        const header = candidate.headerFor(nonce);
        const pow = proofOfWork(header);
        if (accept(pow)) return { nonce, header, pow };
    }
    throw new Error('no nonce satisfied the predicate');
}

module.exports = {
    sha256d, reverse, swapWords, parseTransaction, heightPush, p2pkhHash160, merkleRootFromBranch,
    merkleRootFromList, buildCandidate, proofOfWork, shareDifficulty, targetFromBits, nonceHex, findNonce
};
