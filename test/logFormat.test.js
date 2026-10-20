const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeLogMessage } = require('../lib/logFormat');

describe('sanitizeLogMessage', () => {
    it('replaces terminal escapes, carriage returns and line breaks so input cannot forge log lines', () => {
        const hostile = 'Unknown stratum method: x\r\n2026-01-01T00:00:00.000Z [block] height=1\u001b[2J\u0000';
        const clean = sanitizeLogMessage(hostile);
        assert.doesNotMatch(clean, /[\u0000-\u001f\u007f-\u009f]/);
        assert.match(clean, /^Unknown stratum method: x +2026/);
    });

    it('leaves ordinary messages and long block hex unchanged', () => {
        const hex = 'ab'.repeat(100000);
        assert.equal(sanitizeLogMessage(hex), hex);
        assert.equal(sanitizeLogMessage('Submitted Block using submitblock'), 'Submitted Block using submitblock');
    });
});
