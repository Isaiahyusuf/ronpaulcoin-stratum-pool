const { spawn } = require('node:child_process');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', '..', 'bin', 'pool.js');

function startPoolProcess(env) {
    const child = spawn(process.execPath, [ENTRY], {
        env: { PATH: process.env.PATH, ...env },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const lines = [];
    const watchers = [];
    let exited = null;

    const onData = (stream) => {
        let partial = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
            partial += chunk;
            const parts = partial.split('\n');
            partial = parts.pop();
            for (const line of parts) {
                lines.push(line);
                for (const watcher of watchers.slice()) watcher.check(line);
            }
        });
    };
    onData(child.stdout);
    onData(child.stderr);

    child.on('exit', (code, signal) => {
        exited = { code, signal };
        for (const watcher of watchers.slice()) watcher.fail(new Error(`pool exited (code=${code} signal=${signal})`));
    });

    const waitForLog = (pattern, timeoutMs = 15000, fromIndex = 0) => {
        const earlier = lines.slice(fromIndex).find((line) => pattern.test(line));
        if (earlier) return Promise.resolve(earlier);
        if (exited) return Promise.reject(new Error('pool has exited'));
        return new Promise((resolve, reject) => {
            const watcher = {
                check(line) {
                    if (pattern.test(line)) finish(() => resolve(line));
                },
                fail(error) {
                    finish(() => reject(error));
                }
            };
            const timer = setTimeout(() => finish(() => reject(new Error(`timed out waiting for log ${pattern}`))), timeoutMs);
            const finish = (action) => {
                clearTimeout(timer);
                watchers.splice(watchers.indexOf(watcher), 1);
                action();
            };
            watchers.push(watcher);
        });
    };

    const stop = () => new Promise((resolve) => {
        if (exited) return resolve();
        child.once('exit', resolve);
        child.kill('SIGTERM');
    });

    const waitForExit = (timeoutMs = 15000) => {
        if (exited) return Promise.resolve(exited);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('pool did not exit')), timeoutMs);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve(exited);
            });
        });
    };

    return { lines, waitForLog, waitForExit, stop, isRunning: () => exited === null };
}

module.exports = { startPoolProcess };
