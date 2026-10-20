const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const LEADING_ZERO_CHAR = ALPHABET[0];

function encode(buffer) {
    let remaining = buffer.length ? BigInt(`0x${buffer.toString('hex')}`) : 0n;
    let encoded = '';
    while (remaining > 0n) {
        encoded = ALPHABET[Number(remaining % 58n)] + encoded;
        remaining /= 58n;
    }
    const leadingZeroBytes = buffer.findIndex((byte) => byte !== 0);
    return LEADING_ZERO_CHAR.repeat(leadingZeroBytes === -1 ? buffer.length : leadingZeroBytes) + encoded;
}

function decode(text) {
    let value = 0n;
    for (const char of text) {
        const digit = ALPHABET.indexOf(char);
        if (digit === -1) throw new SyntaxError(`invalid base58 character "${char}"`);
        value = value * 58n + BigInt(digit);
    }
    const leadingZeros = text.length - text.replace(/^1+/, '').length;
    const hex = value === 0n ? '' : value.toString(16);
    const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
    return Buffer.concat([Buffer.alloc(leadingZeros), body]);
}

module.exports = { encode, decode };
