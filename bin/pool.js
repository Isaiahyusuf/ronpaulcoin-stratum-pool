#!/usr/bin/env node
const { loadPoolConfig } = require('../lib/poolConfig');
const { createPoolServer } = require('../lib/poolServer');
const { sanitizeLogMessage } = require('../lib/logFormat');
const { waitForDaemons } = require('../lib/daemonWait');
const { MiningStats } = require('../lib/miningStats');
const { createStatsApi } = require('../lib/statsApi');

let config;
try {
    config = loadPoolConfig();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

let pool;
let stats;
let statsApi;
let stopping = false;

async function closeTelemetry() {
    if (statsApi) {
        await statsApi.close();
        statsApi = null;
    }
    if (stats) {
        stats.close();
        stats = null;
    }
}

function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${new Date().toISOString()} [info] ${signal} received, stopping`);

    if (!pool) {
        process.exit(0);
        return;
    }

    const timeout = setTimeout(() => {
        console.error(`${new Date().toISOString()} [error] Pool shutdown timed out`);
        process.exit(1);
    }, 10000);

    pool.stop((error) => {
        clearTimeout(timeout);
        if (error) {
            console.error(`${new Date().toISOString()} [error] Pool shutdown failed: ${sanitizeLogMessage(error.message)}`);
            process.exit(1);
            return;
        }
        closeTelemetry().then(() => process.exit(0)).catch((cleanupError) => {
            console.error(`${new Date().toISOString()} [error] Statistics shutdown failed: ${sanitizeLogMessage(cleanupError.message)}`);
            process.exit(1);
        });
    });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => stop(signal));
}

const stamp = (severity, message) => console.log(`${new Date().toISOString()} [${severity}] ${sanitizeLogMessage(message)}`);

// A daemon that is down, still starting or restarting is normal on a shared host: wait for it instead of
// exiting, and open nothing (no Stratum port, no jobs) until RPC answers. Configuration errors above exit.
waitForDaemons(config.daemons, { intervalMs: config.daemonRetrySeconds * 1000, log: stamp }).then(async () => {
    if (stopping) return;
    if (config.statistics) {
        try {
            stats = new MiningStats(config.statistics.path);
            statsApi = createStatsApi({
                stats,
                port: config.statistics.port,
                token: config.statistics.token,
                log: (message) => stamp('error', message)
            });
            await statsApi.listen();
            stamp('info', `Private mining statistics API listening on port ${config.statistics.port}`);
        } catch (error) {
            stamp('error', `Mining statistics are unavailable: ${error.message}`);
            if (stats) stats.close();
            stats = null;
            statsApi = null;
        }
    }
    pool = createPoolServer(config, { statsTracker: stats });

    let started = false;
    process.on('exit', (code) => {
        if (!started && !stopping && code === 0) process.exitCode = 1;
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
}).catch((error) => {
    stamp('error', `Pool startup failed: ${error.message}`);
    closeTelemetry().then(() => {
        process.exitCode = 1;
    }).catch((cleanupError) => {
        stamp('error', `Statistics cleanup failed: ${cleanupError.message}`);
        process.exitCode = 1;
    });
});
