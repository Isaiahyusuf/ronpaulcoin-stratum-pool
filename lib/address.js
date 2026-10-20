const crypto = require('node:crypto');
const base58 = require('./base58');

const sha256d = (buffer) => {
    const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
    return sha256(sha256(buffer));
};

function encodeAddress(version, hash160) {
    const body = Buffer.concat([Buffer.from([version]), hash160]);
    return base58.encode(Buffer.concat([body, sha256d(body).subarray(0, 4)]));
}

function decodeAddress(address) {
    if (typeof address !== 'string') return null;
    let payload;
    try {
        payload = base58.decode(address);
    } catch {
        return null;
    }
    if (payload.length !== 25) return null;
    const body = payload.subarray(0, 21);
    if (!sha256d(body).subarray(0, 4).equals(payload.subarray(21))) return null;
    return { version: body[0], hash160: Buffer.from(body.subarray(1)) };
}

function classifyAddress(address, versions) {
    const decoded = decodeAddress(address);
    if (!decoded) return null;
    if (decoded.version === versions.pubkeyHash) return { type: 'pubkeyHash', ...decoded };
    if (decoded.version === versions.scriptHash) return { type: 'scriptHash', ...decoded };
    return null;
}

module.exports = { encodeAddress, decodeAddress, classifyAddress, sha256d };
