const { scryptHash } = require('./scryptHash');

const SUPPORTED_N = 1024;
const SUPPORTED_R = 1;

// Drop-in for the native multi-hashing module, limited to the one algorithm RonPaulCoin uses.
function scrypt(data, N, r) {
    if (N !== SUPPORTED_N || r !== SUPPORTED_R) {
        throw new RangeError(`unsupported scrypt parameters N=${N} r=${r}`);
    }
    return scryptHash(data);
}

module.exports = { scrypt };
