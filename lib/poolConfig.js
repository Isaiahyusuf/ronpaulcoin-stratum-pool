const baseCoin = require('../coins/ronpaulcoin.json');
const { classifyAddress } = require('./address');

const DEFAULTS = { stratumPort: 3333, stratumDifficulty: 1, blockRefreshMs: 1000, jobRebroadcastSeconds: 55, blockSubmitAttempts: 20, blockSubmitRetryMs: 3000,
    blockReconcileAttempts: 5, blockReconcileRetryMs: 3000, daemonRetrySeconds: 5,
    blockRecheckIntervalSeconds: 60, blockRecheckConfirmations: 100, blockRecheckMaxHours: 48,
    maxConnections: 2000, maxConnectionsPerIp: 100, maxProtocolErrors: 20, handshakeTimeoutSeconds: 30,
    invalidSharePercent: 50, invalidShareCheckThreshold: 500,
    messageRateLimit: 1000, messageRateWindowSeconds: 10, maxOutputBufferBytes: 1048576 };

function parseNumber(env, name, fallback, { min, integer = false } = {}) {
    const raw = env[name];
    if (raw === undefined || raw === '') return { value: fallback };
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
        return { error: `${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}` };
    }
    return { value };
}

function parseDaemons(env, errors) {
    const hosts = (env.DAEMON_HOSTS || '').split(',').map((entry) => entry.trim()).filter(Boolean);
    if (hosts.length === 0) errors.push('DAEMON_HOSTS must list at least one host:port');
    if (!env.DAEMON_RPC_USER) errors.push('DAEMON_RPC_USER is required');
    if (!env.DAEMON_RPC_PASSWORD) errors.push('DAEMON_RPC_PASSWORD is required');

    return hosts.map((entry) => {
        const match = /^([^:\s]+):(\d{1,5})$/.exec(entry);
        const port = match ? Number(match[2]) : 0;
        if (!match || port < 1 || port > 65535) {
            errors.push(`DAEMON_HOSTS entry "${entry}" must look like host:port`);
        }
        return {
            host: match ? match[1] : entry,
            port,
            user: env.DAEMON_RPC_USER,
            password: env.DAEMON_RPC_PASSWORD
        };
    });
}

function loadPoolConfig(env = process.env) {
    const errors = [];

    const network = env.POOL_NETWORK;
    const versions = baseCoin.addressVersions[network];
    if (!versions) errors.push(`POOL_NETWORK must be one of ${Object.keys(baseCoin.addressVersions).join(', ')}`);

    const poolAddress = env.POOL_ADDRESS;
    if (!poolAddress) {
        errors.push('POOL_ADDRESS is required');
    } else if (versions) {
        const classified = classifyAddress(poolAddress, versions);
        if (!classified) errors.push(`POOL_ADDRESS is not a valid ${network} address`);
        else if (classified.type !== 'pubkeyHash') errors.push('POOL_ADDRESS must be a pay-to-pubkey-hash address');
    }

    const port = parseNumber(env, 'STRATUM_PORT', DEFAULTS.stratumPort, { min: 1, integer: true });
    const difficulty = parseNumber(env, 'STRATUM_DIFFICULTY', DEFAULTS.stratumDifficulty, { min: Number.MIN_VALUE });
    const refresh = parseNumber(env, 'BLOCK_REFRESH_MS', DEFAULTS.blockRefreshMs, { min: 100, integer: true });
    const rebroadcast = parseNumber(env, 'JOB_REBROADCAST_SECONDS', DEFAULTS.jobRebroadcastSeconds, { min: 1, integer: true });
    const daemonRetry = parseNumber(env, 'DAEMON_RETRY_SECONDS', DEFAULTS.daemonRetrySeconds, { min: 1, integer: true });
    const submitAttempts = parseNumber(env, 'BLOCK_SUBMIT_ATTEMPTS', DEFAULTS.blockSubmitAttempts, { min: 1, integer: true });
    const submitRetryMs = parseNumber(env, 'BLOCK_SUBMIT_RETRY_MS', DEFAULTS.blockSubmitRetryMs, { min: 100, integer: true });
    const reconcileAttempts = parseNumber(env, 'BLOCK_RECONCILE_ATTEMPTS', DEFAULTS.blockReconcileAttempts, { min: 1, integer: true });
    const reconcileRetryMs = parseNumber(env, 'BLOCK_RECONCILE_RETRY_MS', DEFAULTS.blockReconcileRetryMs, { min: 100, integer: true });
    const recheckInterval = parseNumber(env, 'BLOCK_RECHECK_INTERVAL_SECONDS', DEFAULTS.blockRecheckIntervalSeconds, { min: 1, integer: true });
    const recheckConfirmations = parseNumber(env, 'BLOCK_RECHECK_CONFIRMATIONS', DEFAULTS.blockRecheckConfirmations, { min: 1, integer: true });
    const recheckMaxHours = parseNumber(env, 'BLOCK_RECHECK_MAX_HOURS', DEFAULTS.blockRecheckMaxHours, { min: 1, integer: true });
    const journalPath = (env.BLOCK_JOURNAL_PATH || '').trim();
    if (journalPath && !require('node:path').isAbsolute(journalPath)) errors.push('BLOCK_JOURNAL_PATH must be an absolute path');
    const maxConnections = parseNumber(env, 'MAX_CONNECTIONS', DEFAULTS.maxConnections, { min: 0, integer: true });
    const maxConnectionsPerIp = parseNumber(env, 'MAX_CONNECTIONS_PER_IP', DEFAULTS.maxConnectionsPerIp, { min: 0, integer: true });
    const maxProtocolErrors = parseNumber(env, 'MAX_PROTOCOL_ERRORS', DEFAULTS.maxProtocolErrors, { min: 0, integer: true });
    const handshakeTimeout = parseNumber(env, 'HANDSHAKE_TIMEOUT_SECONDS', DEFAULTS.handshakeTimeoutSeconds, { min: 0, integer: true });
    const invalidPercent = parseNumber(env, 'INVALID_SHARE_PERCENT', DEFAULTS.invalidSharePercent, { min: 0 });
    const invalidThreshold = parseNumber(env, 'INVALID_SHARE_CHECK_THRESHOLD', DEFAULTS.invalidShareCheckThreshold, { min: 1, integer: true });
    const messageRate = parseNumber(env, 'MESSAGE_RATE_LIMIT', DEFAULTS.messageRateLimit, { min: 0, integer: true });
    const messageWindow = parseNumber(env, 'MESSAGE_RATE_WINDOW_SECONDS', DEFAULTS.messageRateWindowSeconds, { min: 1, integer: true });
    const outputBuffer = parseNumber(env, 'MAX_OUTPUT_BUFFER_BYTES', DEFAULTS.maxOutputBufferBytes, { min: 0, integer: true });
    if (outputBuffer.value > 0 && outputBuffer.value < 4096) errors.push('MAX_OUTPUT_BUFFER_BYTES must be 0 or an integer >= 4096');
    if (invalidPercent.value > 100) errors.push('INVALID_SHARE_PERCENT must be a number <= 100');
    const statsPath = (env.POOL_STATS_DB || '').trim();
    const statsPort = parseNumber(env, 'POOL_STATS_PORT', 0, { min: 0, integer: true });
    const statsToken = env.POOL_STATS_TOKEN || '';
    const statsConfigured = Boolean(statsPath || env.POOL_STATS_PORT || statsToken);
    if (statsConfigured) {
        if (!statsPath || !require('node:path').isAbsolute(statsPath)) errors.push('POOL_STATS_DB must be an absolute path when stats are enabled');
        if (statsPort.value < 1 || statsPort.value > 65535) errors.push('POOL_STATS_PORT must be an integer from 1 to 65535 when stats are enabled');
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(statsToken)) errors.push('POOL_STATS_TOKEN must be 32-256 URL-safe characters when stats are enabled');
    }
    for (const parsed of [port, difficulty, daemonRetry, refresh, rebroadcast, submitAttempts, submitRetryMs, reconcileAttempts, reconcileRetryMs, recheckInterval, recheckConfirmations, recheckMaxHours, maxConnections,
        maxConnectionsPerIp, maxProtocolErrors, handshakeTimeout, invalidPercent, invalidThreshold, messageRate, messageWindow, outputBuffer, statsPort]) if (parsed.error) errors.push(parsed.error);

    const daemons = parseDaemons(env, errors);

    if (errors.length > 0) throw new Error(`Invalid pool configuration:\n  ${errors.join('\n  ')}`);

    return {
        coin: { ...baseCoin },
        network,
        addressVersions: versions,
        poolAddress,
        daemons,
        stratum: { port: port.value, difficulty: difficulty.value },
        daemonRetrySeconds: daemonRetry.value,
        blockRefreshMs: refresh.value,
        jobRebroadcastSeconds: rebroadcast.value,
        blockSubmitAttempts: submitAttempts.value,
        blockSubmitRetryMs: submitRetryMs.value,
        blockReconcileAttempts: reconcileAttempts.value,
        blockReconcileRetryMs: reconcileRetryMs.value,
        blockJournal: {
            path: journalPath,
            intervalSeconds: recheckInterval.value,
            confirmations: recheckConfirmations.value,
            maxHours: recheckMaxHours.value
        },
        statistics: statsConfigured ? { path: statsPath, port: statsPort.value, token: statsToken } : null,
        limits: {
            maxConnections: maxConnections.value,
            maxConnectionsPerIp: maxConnectionsPerIp.value,
            maxProtocolErrors: maxProtocolErrors.value,
            handshakeTimeoutSeconds: handshakeTimeout.value,
            invalidSharePercent: invalidPercent.value,
            invalidShareCheckThreshold: invalidThreshold.value,
            messageRateLimit: messageRate.value,
            messageRateWindowSeconds: messageWindow.value,
            maxOutputBufferBytes: outputBuffer.value
        }
    };
}

module.exports = { loadPoolConfig };
