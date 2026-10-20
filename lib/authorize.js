const { classifyAddress } = require('./address');

const WORKER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

function parseWorkerLogin(login, addressVersions) {
    if (typeof login !== 'string') return null;
    const separator = login.indexOf('.');
    const address = separator === -1 ? login : login.slice(0, separator);
    const worker = separator === -1 ? 'default' : login.slice(separator + 1);
    if (!WORKER_NAME.test(worker)) return null;
    if (!classifyAddress(address, addressVersions)) return null;
    return { address, worker };
}

function createAuthorizer(addressVersions, onRejected = () => {}) {
    return (ip, port, login, password, callback) => {
        const parsed = parseWorkerLogin(login, addressVersions);
        if (!parsed) onRejected(ip, login);
        callback({ error: null, authorized: parsed !== null, disconnect: false });
    };
}

module.exports = { createAuthorizer, parseWorkerLogin };
