const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function sanitizeLogMessage(message) {
    return String(message).replace(CONTROL_CHARACTERS, ' ');
}

module.exports = { sanitizeLogMessage };
