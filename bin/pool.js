#!/usr/bin/env node
const { loadPoolConfig } = require('../lib/poolConfig');
const { createPoolServer } = require('../lib/poolServer');
const { sanitizeLogMessage } = require('../lib/logFormat');

let config;
try {
    config = loadPoolConfig();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

const pool = createPoolServer(config);

let started = false;
process.on('exit', (code) => {
    if (!started && code === 0) process.exitCode = 1;
});

pool.on('started', () => {
    started = true;
});

pool.on('log', (severity, message) => {
    console.log(`${new Date().toISOString()} [${severity}] ${sanitizeLogMessage(message)}`);
});

pool.on('share', (isValidShare, isValidBlock, data) => {
    if (isValidBlock) {
        console.log(`${new Date().toISOString()} [block] height=${data.height} hash=${data.blockHash} worker=${data.worker}`);
    } else if (data.blockStatus) {
        console.log(`${new Date().toISOString()} [block-${data.blockStatus.replace(' ', '-')}] height=${data.height} hash=${data.blockHash} worker=${sanitizeLogMessage(data.worker)}`);
    } else if (!isValidShare) {
        console.log(`${new Date().toISOString()} [share-rejected] worker=${sanitizeLogMessage(data.worker)} reason=${sanitizeLogMessage(data.error)}`);
    }
});

pool.start();
