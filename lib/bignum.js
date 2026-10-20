const BASE_16 = 16;

class BigNumber {
    constructor(value) {
        this.value = value;
    }

    mul(factor) {
        return new BigNumber(this.value * toBigInt(factor));
    }

    pow(exponent) {
        const exponentValue = toBigInt(exponent);
        if (exponentValue < 0n) throw new RangeError('negative exponent');
        return new BigNumber(this.value ** exponentValue);
    }

    ge(other) {
        return this.value >= toBigInt(other);
    }

    toNumber() {
        return Number(this.value);
    }

    toBuffer() {
        const hex = this.value.toString(16);
        return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
    }

    toString(base = 10) {
        return this.value.toString(base);
    }
}

function toBigInt(operand) {
    if (operand instanceof BigNumber) return operand.value;
    if (typeof operand === 'number' && Number.isSafeInteger(operand)) return BigInt(operand);
    throw new TypeError('operand must be a BigNumber or a safe integer');
}

function parseHex(text) {
    if (!/^[0-9a-fA-F]+$/.test(text)) throw new SyntaxError('invalid hexadecimal string');
    return BigInt(`0x${text}`);
}

function bignum(value, base) {
    if (typeof value === 'string') {
        if (base !== BASE_16) throw new RangeError('only base 16 strings are supported');
        return new BigNumber(parseHex(value));
    }
    return new BigNumber(toBigInt(value));
}

bignum.fromBuffer = (buffer, { endian = 'big' } = {}) => {
    if (buffer.length === 0) return new BigNumber(0n);
    const bytes = endian === 'little' ? Buffer.from(buffer).reverse() : buffer;
    return new BigNumber(BigInt(`0x${bytes.toString('hex')}`));
};

module.exports = bignum;
