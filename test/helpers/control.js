const fs = require('node:fs');
const path = require('node:path');

const CONTROL_DIR = process.env.REGTEST_CONTROL_DIR || '/control';

async function requestFault(action, target, timeoutMs = 90000) {
    const request = path.join(CONTROL_DIR, 'request');
    const response = path.join(CONTROL_DIR, 'response');
    fs.rmSync(response, { force: true });
    const staging = `${request}.tmp`;
    fs.writeFileSync(staging, `${action} ${target}\n`);
    fs.renameSync(staging, request);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(response)) {
            const result = fs.readFileSync(response, 'utf8').trim();
            fs.rmSync(response, { force: true });
            if (result !== 'ok') throw new Error(`${action} ${target}: ${result}`);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${action} ${target}: harness did not answer`);
}

module.exports = { requestFault };
