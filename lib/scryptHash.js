const { scryptSync } = require('node:crypto');

const HEADER_LENGTH = 80;
const SCRYPT_PARAMS = Object.freeze({ N: 1024, r: 1, p: 1 });

// Mirrors scrypt_1024_1_1_256 in the RonPaulCoin daemon: the 80-byte header is both password and salt.
function scryptHash(header) {
    if (!Buffer.isBuffer(header) || header.length !== HEADER_LENGTH) {
        throw new TypeError(`block header must be a ${HEADER_LENGTH}-byte Buffer`);
    }
    return scryptSync(header, header, 32, SCRYPT_PARAMS);
}

module.exports = { scryptHash, HEADER_LENGTH };
