const stratum = require('../vendor/stratum-pool/lib');
const { createAuthorizer } = require('./authorize');
const { createBlockJournal } = require('./blockJournal');

function createPoolServer(config) {
    const pool = stratum.createPool({
        coin: config.coin,
        address: config.poolAddress,
        daemons: config.daemons,
        ports: { [config.stratum.port]: { diff: config.stratum.difficulty } },
        blockRefreshInterval: config.blockRefreshMs,
        jobRebroadcastTimeout: config.jobRebroadcastSeconds,
        blockSubmitAttempts: config.blockSubmitAttempts,
        blockSubmitRetryMs: config.blockSubmitRetryMs,
        blockReconcileAttempts: config.blockReconcileAttempts,
        blockReconcileRetryMs: config.blockReconcileRetryMs,
        connectionTimeout: 600,
        tcpProxyProtocol: false,
        maxConnections: config.limits.maxConnections,
        maxConnectionsPerIp: config.limits.maxConnectionsPerIp,
        maxProtocolErrors: config.limits.maxProtocolErrors,
        handshakeTimeout: config.limits.handshakeTimeoutSeconds,
        messageRateLimit: config.limits.messageRateLimit,
        messageRateWindow: config.limits.messageRateWindowSeconds,
        maxOutputBuffer: config.limits.maxOutputBufferBytes,
        banning: {
            enabled: config.limits.invalidSharePercent > 0,
            time: 0,
            invalidPercent: config.limits.invalidSharePercent,
            checkThreshold: config.limits.invalidShareCheckThreshold,
            purgeInterval: 300
        },
        p2p: { enabled: false }
    }, createAuthorizer(config.addressVersions, config.poolAddress, (ip, login) => {
        pool.emit('log', 'warning', `Rejected worker login "${String(login).slice(0, 64)}" from ${ip}`);
    }));

    if (config.blockJournal.path) {
        const journal = createBlockJournal({
            file: config.blockJournal.path,
            daemonCmd: (method, params, callback) => pool.daemon.cmd(method, params, callback),
            log: (severity, message) => pool.emit('log', severity, message),
            confirmDepth: config.blockJournal.confirmations,
            intervalMs: config.blockJournal.intervalSeconds * 1000,
            maxAgeMs: config.blockJournal.maxHours * 3600 * 1000
        });
        pool.blockJournal = journal;
        pool.on('blockSubmitting', (data) => journal.record({ hash: data.blockHash, height: data.height, worker: data.worker, hex: data.blockHex, status: 'submitting' }));
        pool.on('share', (isValidShare, isValidBlock, data) => {
            if (data.blockStatus) {
                journal.record({ hash: data.blockHash, height: data.height, worker: data.worker, status: data.blockStatus, reason: data.blockStatusReason, hex: data.blockHex });
            }
        });
        pool.on('started', () => journal.start());
    }
    return pool;
}

module.exports = { createPoolServer };
